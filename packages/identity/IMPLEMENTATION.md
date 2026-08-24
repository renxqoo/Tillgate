# identity 施工图（IMPLEMENTATION.md）

> 状态：已完成（2026-08-23 四门全绿 + real PG 7/7；实施记录见 §7）
> 设计基线：DESIGN.md（外部契约/问题域/并发预算——彼处定义，此处不重复）
> 行为规格来源：MIGRATION.md §1（旧测试清单）

---

## 1. 旧实现审计（v1 /Users/wrr/work/ai-getway）

审计范围：`packages/identity-core/src`（17 文件，约 2.6k 行）、`packages/identity/src`（9 文件，约 0.95k 行）、`apps/client-api/src/services/{auth,oauth}.service.ts`（826 行）、`apps/admin-api/src/services/auth.service.ts`（309 行）、`packages/repository/src/user-account.repo.ts`（147 行）、`packages/core/src/redis/auth-guards.ts`（199 行）、`apps/client-api/src/services/rate-counter.ts`。四条标准（正确性/契约符合/实现质量/依赖方向）逐文件过；两段审计（identity-core 系 IC#、app 消费面系 ID#）合并编号如下。

**关键结构性事实（裁决前提）**：v1 apps 实际运行「Bearer JWT + users/admins 表列 + Redis」体系；identity-core 七表中**只有 identity_challenges 经 login-challenger 真实消费**，identity_session_anchors 仅 admin 改邮箱单点写入且无读者（B01），credentials/passwords/oauth/totp/recovery_codes 五表**生产为空**（apps 走 users.password_hash 直写路径）。因此 v2 以七表为凭据单一事实源是**净迁移**而非数据合并——唯一存量数据是 users/admins.password_hash（`salt:hash:N:r:p` 段序）与 in-flight 挑战行。

### 1.1 真 bug / 缺陷（B#）

| #   | 来源                | 位置                                                              | 级别 | 结论                                                                                                                                                                                                            |
| --- | ------------------- | ----------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | ID1                 | admin users.service.ts:166-171 vs client auth.service.ts:245-250  | 高   | 会话失效线双库分裂：改邮箱写锚点表、校验读 users 列，强制下线无效。**v2 收敛**：单一真相 = identity_session_anchors（realm 泛化 user/admin）；users.session_invalid_before 冻结只读，apps 切换后退役（§1.3 G1） |
| B02 | ID2                 | identity middleware/*.ts + cookies.ts                             | 高   | Cookie 中间件层死代码（apps 零挂载）。**不移植**；Bearer 语义在 MIGRATION §1 留档供 apps 波次                                                                                                                   |
| B03 | IC1                 | identity-core credentials.ts:66-76 / oauth.ts:82-92               | 中   | tx 注入路径审计先于事务提交发出。**v2 修复**：facade 零 DbTx；自有事务用例 runTx 提交后发审计；./composition bridge 返回 auditEvents 由调用方提交后冲洗                                                         |
| B04 | IC2                 | identity-core passwords.ts:70-91                                  | 中   | changePassword 验旧密（锁外）与换哈希（锁内）TOCTOU。**v2 修复**：全判定收进 advisoryLock 临界区同事务                                                                                                          |
| B05 | ID3+ID4             | identity login-challenge.ts:66-67/95-96                           | 中   | 投递上下文模块级 Map 跨 kind 串号 + 异常路径泄漏。**v2 根治**：ip/locale 仅在 begin 调用栈内流动（随 mailer 上下文透传、不落库），模块级 Map 串号面被结构性移除                                                 |
| B06 | ID5                 | identity session.ts:146-157                                       | 中   | 吊销存储故障语义矛盾（写抛/读吞）。**v2 统一并文档化**：读 fail-open + logger.warn（可用性取舍，明确声明），写上抛（unavailable）；logout 幂等重试语义归 app 映射                                               |
| B07 | ID6                 | client/admin auth.service.ts                                      | 中   | 软锁不降低爆破吞吐。**不在本单元**：防暴破策略归 apps 装配（DESIGN §1 留白）；MIGRATION §8 挂待办                                                                                                               |
| B08 | IC3                 | identity-core revocation.ts:70-71                                 | 中   | sessionValidAt realm 只验格式 fail-open。**v2 修复**：读路径同白名单 fail-closed（unknown_realm）                                                                                                               |
| B09 | ID8                 | admin auth.service.ts:273-294                                     | 中   | admin 改密无审计。**v2 修复**：change/reset 统一 AuditPort（realm 参数化）                                                                                                                                      |
| B10 | IC4                 | identity-core challenge.ts:212/273、revocation.ts:66、identity.ts | 低   | 验码/作废/认证/会话校验无审计。**v2 修复**：application 层统一发审计（§2.2 词表）                                                                                                                               |
| B11 | IC5                 | identity-core challenge.ts:197                                    | 低   | 投递失败补救 abort 静默吞。**v2 修复**：logger.warn                                                                                                                                                             |
| B12 | IC6                 | identity-core challenge.ts:209                                    | 低   | 无投递器时明文码静默返回。**v2 修复**：可投递通道无投递器 = undeliverable（fail-closed，不建挑战）；code 返回保留（v1 契约，非邮件通道消费）                                                                    |
| B13 | IC7                 | identity-core challenge.ts:37-39 / mfa.ts:32-34                   | 低   | 短码哈希无 pepper（6 位码空间秒级离线枚举）。**v2 修复**：challenge/恢复码统一 HMAC-SHA256(pepper)。生产恢复码表为空（结构性事实），无存量兼容负担                                                              |
| B14 | IC9                 | identity-core challenge.ts:141 vs :162                            | 低   | 冷却判定（DB 钟）与 retryAfterMs（JS 钟）不同钟。**v2 修复**：store 返回 DB now，剩余时长同钟计算                                                                                                               |
| B15 | IC8                 | identity-core passwords.ts:90/123 vs challenge.ts                 | 低   | 时钟纪律域间混用。**v2 口径**：挑战域 DB 时钟单源；锚点/JWT/审计注入 clock；两域不互比（DESIGN §3）                                                                                                             |
| B16 | IC10                | identity-core types.ts                                            | 低   | 事务注入 API 面不一致（仅 2 动词支持 tx）。**v2 修复**：facade 全零 DbTx；跨能力原子经 ./composition                                                                                                            |
| B17 | IC11                | identity-core credentials.ts:41                                   | 低   | updatedAt 写 JS Date。**v2 修复**：SQL now()                                                                                                                                                                    |
| B18 | ID7                 | 两 app auth.service PASSWORD_POLICY 双拷贝 + 验码状态码漂移       | 低   | **v2 修复**：策略单源 domain/password.ts 装配注入；状态码映射归 app face（错误目录单一真相后自然收敛）                                                                                                          |
| B19 | IC14                | identity-core mfa.ts:148-175                                      | 极低 | confirmTotp 同批恢复码哈希碰撞炸事务。**v2 修复**：onConflictDoNothing 防御                                                                                                                                     |
| B20 | IC15                | identity-core oauth.ts:135-141                                    | 极低 | unlinkOAuth 审计 targetId 语义错位。**v2 修复**：统一 linkId                                                                                                                                                    |
| B21 | IC16                | identity-core mfa.ts:218-239                                      | 极低 | verifyMfa TOTP 重放与恢复码共用错误路径。**接受**（防枚举统一口径）；context 带 attemptType 观测                                                                                                                |
| B22 | IC17+ID6            | identity-core passwords.ts:24-47                                  | 信息 | authenticate 无防暴破钩子。**归 apps**（DESIGN §1）                                                                                                                                                             |
| B23 | IC18                | identity-core credentials.ts:60-63                                | 信息 | registerCredential 重放分支静默丢 passwordHash。**接受并显式化**：重放返回 replayed=true 且不改密码（调用方可见，文档声明「设初始密码走 reset」）                                                               |
| B24 | IC19                | identity-core totp.ts:81                                          | 信息 | totp 比较非常数时间。**接受**（公认不可利用；防时序枚举由 password 哑哈希覆盖）                                                                                                                                 |
| B25 | ID9+ID10            | client auth.service.ts:367-386/283-286                            | 低   | 封禁状态可探测 + 注册邮箱枚举。**编排面归 apps**；identity 统一 invalid_credentials 不泄露成败（MIGRATION §1 留档 v1 语义供 app 波次对照）                                                                      |
| B26 | ID12                | verify 二步无守卫复查                                             | 低   | **归 apps 编排**；挑战 5 次上限 + UUID 不可枚举兜底（documented）                                                                                                                                               |
| B27 | ID13                | oauth.service.ts:173-183                                          | 低   | GitHub 邮箱拉取静默吞错。**v2 修复**：上游故障记 warn，email=null 显式返回（不阻断建号，v1 语义）                                                                                                               |
| B28 | ID14                | client/admin changePassword                                       | 低   | 失效线与新令牌双取单机时钟。**v2 缓解**：锚点推进 SQL now()（DB 钟）+ GREATEST 防倒退；token iatMs 注入 clock 单源（DESIGN §3）                                                                                 |
| B29 | IC12+IC13+ID15+ID11 | 构建/文档/依赖漂移族                                              | 低   | bun/node 错配、动词数漂移、ioredis/zod/http 冗余依赖、空 if 块。**不适用/不移植**（v2 重写天然消除）                                                                                                            |
| B30 | v1 captcha          | captcha.ts:91-99                                                  | 低   | 半配抛错语义保留；env 解析归 app 装配，本包 adapter 只收显式参数                                                                                                                                                |

**实测确认**：B01/B02/B03/B04/B05/B08 经代码路径逐行核对（含 v1 测试自证：credentials.test.ts:70-88 即 B03 的回滚场景）；阴性结论——verifyChallenge 单条 CAS 无竞态、挑战锁+部分唯一索引自洽、TOTP 步进 CAS 与 GREATEST 单调正确、scrypt 恶意参数防护完备（v1 测试锁定，real PG 门禁复验）。

### 1.2 重复与提取（D#）

| #   | v1 现状                                                                | v2 提取                                                                                    |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D1  | 七表 DDL 双轨（drizzle 定义 + 手写 IDENTITY_DDL 人工同步）             | 单一真相 = `@tillgate/db` schema/identity.ts；迁移 0076 由定义生成同序收录（§2 DDL 先行） |
| D2  | 密码策略双拷贝（两 app 各一份 PASSWORD_POLICY）                        | domain/password.ts 单源，装配注入                                                          |
| D3  | 用户/管理员认证链同构复制（validateSession/login/changePassword ×2）   | realm 参数化单实现（v1 身份隔离语义保留：独立密钥/issuer/词表桶）                          |
| D4  | v1 login-challenge 在 core 之上再造一层（kind 映射 + 错误翻译 + 配置） | 并入 application/begin-challenge 等（kind 映射 = 挑战词表直接装配，无中间层）              |
| D5  | RepoContext/AnyPgDatabase/DbLike 各包自造                              | `@tillgate/db` 收敛（runTx/advisoryLock/23505 判别直接复用）                              |
| D6  | 验证码邮件渲染与 Mailer 实现耦合                                       | templates/login-code-email.ts 纯函数 + adapter 仅传输                                      |
| D7  | OAuth state 双提交 cookie 比对逻辑在 app                               | state 签发/消费归本包 port；cookie 比对归 app（HTTP 关注点）                               |

### 1.3 契约缺口（演进决策）

- **G1（users/admins 列退役）**：v2 凭据单一事实源 = 七表；users.password_hash/session_invalid_before、admins.password_hash/two_factor_secret/session_invalid_before 冻结只读。存量数据迁移（`salt:hash:N:r:p` → `scrypt:N:r:p:salt:hash` 机械转换 + 锚点回填 + admins two_factor 偏好去处）在 apps 切换单元执行；退役 DDL 挂 MIGRATION §8。本单元不携带 schema 语义变更（迁移 0076 只新建七表，if not exists 幂等，revert 无数据回滚）。
- **G2（wire 契约）**：注册/登录/验证码端点的 zod 契约与状态码映射归未来 client-api/admin-api 的 http/contracts（v1 语义在 MIGRATION §1 留档）。
- **G3（密码策略统一）**：v1 用户面 10..128 与管理面重置 8..128 分裂——v2 单源策略装配注入；如需分面策略由装配传不同 policy 实例（B18 相关）。
- **G4（OAuth find-or-create）**：建资料行归 accounts（provisionOAuthAccount 已建）；本包只做 find/link——app 编排两者（v1 oauth.service 语义在 MIGRATION §1 留档）。

## 2. 逐模块裁决表

| v1 文件                                                                      | 裁决                 | 审计状态                         | 动作                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| identity-core password.ts                                                    | 复制+微修            | 通过（B24 接受）                 | domain/password.ts；scrypt 格式/哑哈希/策略逐语义保留                                                                                                                    |
| identity-core totp.ts                                                        | 复制                 | 通过                             | domain/totp.ts（RFC 向量测试随迁）                                                                                                                                       |
| identity-core validation.ts                                                  | 复制+微修            | 通过                             | domain/identifier.ts + domain/config.ts 的词表守卫；errors 目录化                                                                                                        |
| identity-core challenge.ts                                                   | 重构                 | 通过（B11/B12/B13/B14 修复）     | 纯部分→domain/challenge.ts（HMAC 码哈希/参数界）；PG 动词→store + application/{begin,verify,abort}-challenge.ts；投递上下文入行 payload                                  |
| identity-core credentials.ts                                                 | 复制+微修            | 通过（B03/B17 修复，B23 显式化） | application/register-credential.ts + store 动词                                                                                                                          |
| identity-core passwords.ts                                                   | 重构                 | 通过（B04 修复）                 | application/{authenticate-password,change-password,reset-password}.ts；验旧密入锁内                                                                                      |
| identity-core mfa.ts                                                         | 复制+微修            | 通过（B13/B19/B20/B21 裁决）     | application/{enroll-totp,confirm-totp,verify-mfa,disable-totp}.ts                                                                                                        |
| identity-core oauth.ts                                                       | 复制+微修            | 通过                             | application/{find-oauth-user,link-oauth,unlink-oauth}.ts                                                                                                                 |
| identity-core revocation.ts                                                  | 复制+微修            | 通过（B08 修复）                 | application/revocation*.ts + store 动词；realm 白名单双路径                                                                                                              |
| identity-core schema.ts                                                      | 重构                 | 通过（D1）                       | drizzle 定义迁 @tillgate/db schema/identity.ts；DDL 迁移 0076 同序收录；provision/migrate-cli/deprovision 不移植（迁移链统一 db 包）                                    |
| identity-core internal.ts                                                    | 不移植               | —                                | runTx/advisoryLock/23505 = @tillgate/db 现有能力；锁键构造器实迁本包 domain/locks.ts（credentialSetLockKey/challengeLockKey 两键，无 shared.ts）                        |
| identity-core context.ts / types.ts / errors.ts / index.ts / identity.ts     | 重构                 | 通过                             | config 解析→domain/config.ts；types 按用例拆入各 application 文件；errors→目录（§DESIGN 2.3）；facade 重写                                                               |
| identity session.ts                                                          | 复制+微修            | 通过（B06 口径）                 | domain/session.ts（契约）+ adapters/jwt/jose-tokens.ts（jose）+ adapters/redis/revocation-store.ts                                                                       |
| identity login-challenge.ts                                                  | 重构                 | 通过（B05 根治，D4）             | 并入 application/begin-challenge 等；kind 词表装配直配                                                                                                                   |
| identity mailer.ts                                                           | 重构                 | 通过（D6）                       | templates/login-code-email.ts（渲染纯函数）+ adapters/smtp/nodemailer-mailer.ts                                                                                          |
| identity captcha.ts                                                          | 复制+微修            | 通过（B30）                      | adapters/turnstile/captcha.ts；captchaFromEnv 归 app 装配                                                                                                                |
| identity cookies.ts / middleware/*.ts / types.ts                             | 不移植               | B02 死代码                       | —                                                                                                                                                                        |
| client-api oauth.service.ts                                                  | 重构                 | 通过（B27 修复，D7）             | state+profile 半程→本包 application/{oauth-authorize,oauth-callback}.ts + adapters/oauth/{github,google}.ts；find-or-create 编排→apps（G4）；safeNext/cookie 双提交→apps |
| client/admin auth.service.ts                                                 | 不移植（机制已覆盖） | —                                | HTTP 编排/限流/状态码映射归 apps 波次；行为规格 MIGRATION §1 留档                                                                                                        |
| user-account.repo.ts / credential.repo.ts / auth-guards.ts / rate-counter.ts | 不移植               | —                                | 前者归 accounts（已建）；后三者归 apps 装配（DESIGN §1）                                                                                                                 |

## 3. 目标目录

```
packages/identity/
├── src/
│   ├── domain/
│   │   ├── errors.ts               # identity.* 错误目录
│   │   ├── identifier.ts           # 标识归一化/守卫（email/phone/username）
│   │   ├── password.ts             # scrypt 哈希/校验/策略（哑哈希恒定时间）
│   │   ├── totp.ts                 # base32/HOTP/TOTP/恢复码生成
│   │   ├── challenge.ts            # 码哈希(HMAC pepper)/参数界/payload 界
│   │   ├── session.ts              # 令牌载荷契约/TTL 界/realm 派生
│   │   ├── audit-events.ts         # 审计动作词表 + 事件构造
│   │   └── config.ts               # 装配配置解析（词表/数值界 fail-fast）
│   ├── application/
│   │   ├── context.ts              # UseCaseContext（resolved config + ports）
│   │   ├── register-credential.ts  # 标识绑定（+可选首密码；冲突分类；审计后置）
│   │   ├── authenticate-password.ts
│   │   ├── change-password.ts      # 锁内验旧密（B04）
│   │   ├── reset-password.ts
│   │   ├── begin-challenge.ts      # 冷却/替换/投递（ip/locale 入行）
│   │   ├── verify-challenge.ts     # CAS 三态翻译
│   │   ├── abort-challenge.ts
│   │   ├── enroll-totp.ts / confirm-totp.ts / verify-mfa.ts / disable-totp.ts
│   │   ├── find-oauth-user.ts / link-oauth.ts / unlink-oauth.ts
│   │   ├── oauth-authorize.ts      # state 签发 + 授权 URL
│   │   ├── oauth-callback.ts       # state 消费 + code→profile
│   │   ├── sign-session.ts / verify-session.ts / validate-session.ts / logout.ts
│   │   └── revocation.ts           # advance/revoke/validAt（realm 白名单双路径）
│   ├── ports/
│   │   ├── credential-store.ts / challenge-store.ts / mfa-store.ts /
│   │   ├── oauth-store.ts / anchor-store.ts
│   │   ├── mailer.ts / captcha.ts / oauth-provider.ts / oauth-state-store.ts
│   │   ├── session-tokens.ts / session-revocation-store.ts
│   │   └── secret-cipher.ts / audit.ts / clock.ts
│   ├── adapters/
│   │   ├── postgres/{shared,credentials,passwords,challenges,mfa,oauth,anchors,identity-store}.ts
│   │   ├── jwt/jose-tokens.ts
│   │   ├── redis/{revocation-store,oauth-state-store}.ts
│   │   ├── smtp/nodemailer-mailer.ts
│   │   ├── turnstile/captcha.ts
│   │   └── oauth/{github,google}.ts
│   ├── templates/login-code-email.ts
│   ├── testing/{in-memory-identity-store,harness}.ts
│   ├── identity.ts                 # createIdentity facade
│   ├── composition.ts              # 同事务参与 bridge（auditEvents 后置冲洗）
│   └── index.ts
└── __test__/                        # 平铺（铁律 14）；*.real.test.ts 默认排除
```

配套（DDL 先行，同一迁移单元先合入）：`packages/db/src/schema/identity.ts`（七表 drizzle 定义）+ `packages/db/migrations/0076_identity_tables.sql` + journal idx 76 + schema/index.ts 出口。

## 4. 关键实现口径（防漂移）

1. **begin-challenge**（v1 逐语义 + 修复）：目标解析（identifier 目标 → email 优先投递、phone→sms、无可投递凭据/username → undeliverable fail-closed；userId 目标 → 查其 email/phone 凭据，email 优先）→ 可投递通道无投递器 = undeliverable（B12）→ advisoryLock(`identity.challenge:{kind}:{target}`) 内：活挑战冷却判定（DB clock_timestamp，B14）→ 命中冷却抛 challenge_cooldown(retryAfterMs 同钟计算) → 替换旧挑战（终态化）→ INSERT（payload 含业务 payload + `{deliveryIp, deliveryLocale}`）→ 提交后投递 → 失败：abort（失败再 logger.warn，B11）+ delivery_failed（冷却让位，可立即重发）→ 审计 challenge.begin。
2. **verify-challenge**：单条 CAS UPDATE（`where id and code_hash = hmac(code:id) and consumed_at is null and aborted_at is null and expires_at > clock_timestamp()`；命中 → consumed；未命中 → attempts+1 且 attempts < max，返回 remaining；attempts 耗尽或行不存在/终态/过期 → challenge_invalid 不细分）。三态翻译：code_invalid(remaining>0) / challenge_invalid。审计 challenge.verify。
3. **authenticate-password**：按归一标识查 (userId, passwordHash)；不存在 → 哑哈希（防时序枚举）后统一 invalid_credentials；存在 → verifyPassword；成功返回 {userId}。审计 credential.authenticate（context 带 outcome，不含明文事实）。
4. **change-password**：advisoryLock(`identity.user:{userId}`) 内读哈希 → 验旧密（错 = invalid_credentials，哈希与锚点均不动）→ 策略 → 新哈希 UPDATE + advanceAnchor（SQL now()，同事务）。审计 password.change。reset-password：免旧密 upsert + 推锚点，弱口令拒绝时旧密码保持。
5. **mfa**：enroll（20 字节 base32 密钥，已确认拒绝 totp_already_enrolled，挂起重挂换钥 lastUsedStep=-1；cipher 在场则密文落库）→ confirm（锁外匹配码 → 锁内 CAS 置 confirmed + lastUsedStep=step + 恢复码整组重签 HMAC 哈希 onConflictDoNothing B19）→ verify（TOTP 步进单调 CAS `last_used_step < step`；失败落恢复码分支 used_at CAS 单次消费；码 trim().toUpperCase()）→ disable（已确认必须先 verify；挂起免码；连恢复码删）。审计 mfa.*。
6. **oauth**：link（advisoryLock(credentialSetLockKey(userId) = `identity.user:{userId}`) + onConflictDoNothing 双索引兜底 + 读回分类 replay/provider_identity_taken/user_already_linked）；unlink（锁内 for update + 凭据集非空判定（密码或≥2 绑定）→ last_credential 保护）；find（provider+subject → userId|null）。authorize：state=randomBytes(24)hex → oauthStateStore.save(TTL) → provider.authorizeUrl（redirect_uri/scope）。callback：state consume（GETDEL；不存在/过期 = oauth_state_invalid）→ provider.exchangeAndProfile（失败 = oauth_profile_failed；GitHub emails 端点失败 warn + email=null，B27）。审计 oauth.link/unlink。
7. **sessions**：sign（jose HS256，iss/realm/secret 每 realm；jti=randomUUID；iatMs=clock.now()）→ verify（算法白名单 + issuer + 载荷 realm 三重校验，失败 invalid_token(reason)）→ validate（verify → jti 黑名单（缺省无面；读故障 fail-open+warn）→ validAt（锚点线，无锚点全有效））→ logout（revocationStore.revoke(jti, exp-iat 剩余 TTL)，写失败上抛 unavailable）。
8. **revocation**：advance（upsert + GREATEST 单调，SQL now()）；revoke（realm 白名单 fail-closed）；validAt（同白名单 B08；iatMs 接受 Date|epoch 毫秒，NaN/0 拒绝）。
9. **postgres store**：SQL 与 v1 逐语义对齐（CAS/锁/部分唯一索引/23505 判别经 @tillgate/db）；时间戳一律 SQL now()；行投影不含秘密列（challenge 行不携 code_hash 出域——哈希匹配在 SQL 内完成）。
10. **composition bridge**：`identityWithinTx(tx)` → { registerCredential } 返回 { result, auditEvents }；调用方事务提交后冲洗 auditEvents（B03 契约文档化）。根 facade 零 DbTx。

## 5. 测试计划

| 新测试                                                                                            | 承载规格                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain-password.test.ts                                                                           | scrypt 往返/存储格式快照/自描述参数（N=16384 历史哈希可验）/哑哈希恒定时间（不存在账号耗时 ≥ 真实一半）/脏 stored 恒 false/策略矩阵（短/超长/validate 钩子/非法配置 resolve 即抛）/10 万字符不崩（B 系安全用例随迁）                                                                                                                    |
| domain-totp.test.ts                                                                               | base32 RFC 4648 向量/任意长度往返/大小写容忍/非法字符抛错/RFC 6238 Appendix B 五向量/前导零/matchingTotpStep ±1 窗口/恢复码字母表与形状                                                                                                                                                                                                 |
| domain-identifier.test.ts                                                                         | email trim+小写/坏形状、phone 分隔符归一、username 字符集 3-64、词表白名单（unknown 带 allowed）、userId 断言矩阵、subject trim 1-255                                                                                                                                                                                                   |
| domain-challenge.test.ts                                                                          | HMAC 码哈希已知向量/参数覆盖界（ttl/cooldown/maxAttempts/digits 越界拒）/payload 4KB 与序列化校验                                                                                                                                                                                                                                       |
| domain-session.test.ts                                                                            | 载荷契约（realm/sub/jti/iss/exp-iat=TTL）/TTL 界/realm 派生 issuer                                                                                                                                                                                                                                                                      |
| errors.test.ts                                                                                    | 目录码快照（封闭）/category 分布与 DESIGN §2.3 表逐项相等                                                                                                                                                                                                                                                                               |
| application-credentials.test.ts                                                                   | 注册落行/同用户重挂幂等同 id/他人占用 identifier_taken/非本包格式 passwordHash 拒/重放 replayed=true 不改密码（B23）/归一形态唯一                                                                                                                                                                                                       |
| application-passwords.test.ts                                                                     | authenticate 防枚举（未知标识与错密码同码同文案）/OAuth-only invalid_credentials/改密正确流（旧会话失效新会话有效）/旧密错哈希锚点均不动/弱口令原密码保持/reset 免旧密+设初始密码/**B04 回归：改密期间并发 reset 不被覆盖（锁内验旧密）**                                                                                               |
| application-challenge.test.ts                                                                     | 发码投递（ip/locale 随行，B05 回归：同邮箱双 kind 并发不串号）/一次性消费/错次递减耗尽即死/过期即死/abort 幂等+终态互斥/冷却 retryAfterMs/cooldown=0 替换语义活挑战恒一条/kind 分桶互不冷却/投递失败作废+立即可重发（B11：abort 失败 warn）/payload 域/userId 目标 email 优先/无可投递凭据 undeliverable/无 mailer=undeliverable（B12） |
| application-mfa.test.ts                                                                           | enroll 挂起+confirm 生效+恢复码只存 HMAC 哈希/confirm 错码仍挂起/已确认再操作 Already/挂起重挂换新钥/TOTP 码不可重放（步号单调）/恢复码单次消费/未注册 NotEnrolled/乱码 Invalid/已确认 disable 必须携有效码全清/挂起免码直删/cipher 下库内密文≠明文                                                                                     |
| application-oauth.test.ts                                                                         | 绑定可寻址/同人同 provider 幂等重放/(provider,subject) 第二用户 provider_identity_taken/同用户第二账号 user_already_linked/不同 provider 并存/最后凭据不可解绑/有密码兜底可解绑二次 NotFound/authorize state 签发+callback 消费单次/state 不匹配拒/provider 未配置 404 语义                                                             |
| application-session.test.ts                                                                       | 签发-验签往返/跨 realm 互验拒绝（user↔admin）/错密钥/过期/乱码/jti 每次不同/validate：jti 黑名单命中拒/锚点线前失效线后有效/无锚点全有效/logout 写入黑名单                                                                                                                                                                              |
| （并入 application-session.test.ts:147 的 revocation describe，收口轮合并——B08 回归用例全数保留） |
| adapters-turnstile.test.ts                                                                        | 成功请求形状（POST/form/三字段）/客户端过错码→invalid/其余→unavailable/网络失败/非 200/非 JSON/空 token 本地拒不触网                                                                                                                                                                                                                    |
| adapters-oauth-providers.test.ts                                                                  | github/google 授权 URL 形状/code 交换请求形状/profile 映射（primary+verified 过滤）/上游失败→oauth_profile_failed（B27：emails 失败 warn+email=null）                                                                                                                                                                                   |
| templates-login-code-email.test.ts                                                                | 中英双语要素（码/时效/IP/品牌）/HTML 内联样式/语言切换/品牌切换                                                                                                                                                                                                                                                                         |
| concurrency.test.ts（内存）                                                                       | 同码并发验恰 1 成功/并发一错一对 attempts 不越界/cooldown=0 并行发码全成功活挑战一条/冷却期并行至多 1 成功/异目标互不干扰（v1 challenge-concurrency 语义内存复演）                                                                                                                                                                      |
| architecture.test.ts                                                                              | 分层 import 门禁（notifications 同款）+ 全包禁 hono/http/runtime/业务能力包 + index.ts 不泄 Db/DbTx/adapter                                                                                                                                                                                                                             |
| postgres.real.test.ts                                                                             | 七表 DDL fixture + 上述并发语义真实 PG 复验（CAS 单赢家/部分唯一索引/锚点 GREATEST/TOTP CAS/恢复码单次/OAuth 并发绑定/凭据并发注册/23505 翻译）                                                                                                                                                                                         |

## 6. 实施顺序

1. DDL 先行（@tillgate/db schema/identity.ts + 0076 + journal，独立提交）→ 2. domain 八件 + errors → 3. ports 十四件 → 4. application 二十件 + templates → 5. adapters + testing + facade + composition + index → 6. 测试全套 → 7. 四门 + 覆盖率核销。

## 7. 实施记录（收口，2026-08-23）

- 代码落地 = §3 目标树全量（domain 八件 / application 二十件 / ports 十四件 / adapters /
  templates / testing / composition bridge / facade / index）；§5 测试计划 16 个测试文件
  全数落地（含 postgres.real.test.ts）。
- 门禁：typecheck 0 错；oxlint 0-0；vitest 默认门 187/187（16 文件，real 按铁律 14 排除）；
  real PG 门 7/7（env 注入复跑：CAS 单赢家/部分唯一索引/锚点 GREATEST/TOTP 步进 CAS/
  恢复码单次/OAuth 并发绑定/凭据并发注册/composition 随事务回滚 B03）；build 双入口
  （index 78.70 KB + composition 30.39 KB）。
- 文档状态行此前未随实施同步（「实施中」为滞后标记），本次收口回销。
- 遗留挂账（裁决不变）：B07/B22/B25/B26 归 apps 装配与编排（§1.1）；G2 wire 契约归
  client-api/admin-api 的 http/contracts（MIGRATION §1 留档对照）；identity auditSink
  的 app 桥接（审计事件→audit_logs）挂 apps 登录波（P2）。
