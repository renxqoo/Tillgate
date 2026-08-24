# identity 设计基线（DESIGN.md）

> 状态：定稿
> 迁移单元：身份认证完整能力（凭据 + 密码 + 统一挑战 + MFA + OAuth 绑定 + JWT 会话 + 会话吊销）——总纲 §3/P4.1「事件与身份基础」波次
> 旧实现：/Users/wrr/work/ai-getway（packages/identity-core 约 2.6k 行源 / 13 个旧测试文件 + packages/identity 约 0.95k 行源 / 6 个旧测试文件 + apps/client-api 与 apps/admin-api 的 auth/oauth service 约 1.6k 行——后者的 HTTP 编排与 wire 映射归未来 apps 波次，本单元只迁其身份机制语义）
> 目标位置：packages/identity
> 关联：IMPLEMENTATION.md（审计 B#/D# 与逐模块裁决）、MIGRATION.md（行为规格与测试矩阵）

---

## 1. 问题域

**处理**：

1. **标识 ↔ 主体绑定（identity_credentials）**：一个标识（email/phone/username，归一化后）至多绑一个主体 id；同主体重挂幂等；他人占用显式冲突。userId 由消费方（accounts）分配——本包不建资料行。
2. **密码（identity_passwords）**：scrypt 哈希/校验（哑哈希恒定时间防枚举）、策略（min/max/自定义钩子）、改密（验旧密入临界区）、重置（免旧密）；两者均同事务推进会话吊销线。
3. **统一挑战（identity_challenges）**：登录码/注册码/找回码等按 kind 分桶；码只存 HMAC(pepper) 哈希；一次性消费、错次上限行快照、TTL、同 kind 同目标冷却（部分唯一索引 + advisoryLock 替换语义）；投递失败即作废可立刻重发；投递上下文（ip/locale）随挑战行内存储（v1 模块级 Map 串号根治）。
4. **MFA（identity_totp + identity_recovery_codes）**：RFC 6238 TOTP（挂起→确认两段注册、步号单调 CAS 防重放）、恢复码（只存哈希、单次消费、去 I/L/O/0/1 字母表）；TOTP secret 可经 SecretCipher 加密落库。
5. **OAuth 绑定（identity_oauth_links）**：(provider, subject) 防劫持唯一 + (userId, provider) 单绑定；link/unlink/find 三动词 + 最后凭据保护；OAuth 握手半程（state 签发/消费、code→profile 的 GitHub/Google 上游适配）。
6. **JWT 会话与吊销**：HS256 双身份隔离令牌（realm 参数化 user/admin，独立 issuer/secret/TTL）；jti Redis 黑名单（读 fail-open + warn、写上抛）；吊销锚点表 `identity_session_anchors`（GREATEST 单调，realm 泛化）——**会话失效线单一真相源**（v1 双库分裂 B01 收敛于此）。
7. **人机验证（Turnstile）**：siteverify 校验，客户端过错 invalid / 其余一律 unavailable（fail-closed 防「打瘫厂商免验证」）。
8. **验证码邮件渲染**：中英双语、品牌注入、含来源 IP 与时效。

**不处理**（写清归属，不留白）：

- **用户/管理员资料行与状态**（users/admins 表、封禁 status、display name）：归 `accounts`（v2 已建）。会话校验链中的「属主回查 + status 检查」由未来 app assembly 编排（identity 只验签 + jti + 锚点线）——identity 只返回身份主体标识，不依赖用户资料（总纲 §5.2 防环）。
- **注册/登录的 HTTP 编排**（captcha 时机、per-IP 限流、邮箱占用检查的响应语义、两步流程的状态码映射）：归未来 apps/client-api 与 apps/admin-api（v1 auth.service 语义在 MIGRATION §1 留档，供 apps 波次行为对照）。
- **防暴破限流/锁定**（v1 core/auth-guards 的 Redis 双锁）：v1 即为 app 装配层消费，策略随端点走；归 apps 装配（B07/B22 留档）。本包 authenticate 统一 invalid_credentials 口径不泄露成败细节。
- **users.password_hash / admins.password_hash / session_invalid_before 列**：v1 遗留事实源，v2 冻结只读；生产数据迁移（格式转换 + 锚点回填）在 apps 切换单元执行，完成后随 DDL 退役（MIGRATION §6/§8）。
- **HTTP middleware/cookie 层**：v1 identity 包的 cookie 中间件是死代码（B02），不移植；Bearer 传输与 401 语义归 apps。
- **管理员 per-admin 邮箱验证码开关（two_factor_enabled）**：登录策略偏好，归消费方资料/装配；本包挑战机制对所有 realm 通用。
- **审计持久化**：本包经 AuditPort 发事件（动作词表见 §2.6），持久化归 observability/admin-api 装配。

## 2. 外部契约

### 2.1 facade（createIdentity）

参数平铺、结果不嵌套 Db/DbTx/adapter 类型（总纲 §5.3/§5.4——facade 零 DbTx）：

```ts
createIdentity({
  db,                        // Db（内部组装 postgres store；可覆盖 store 用于测试）
  txRetry,                   // TxRetryPolicy（@tillgate/db）
  clock,                     // { now(): Date }——锚点/JWT iat/审计时间单源注入
  logger,                    // { warn } 面（吊销读降级/投递补救失败/上游故障）
  config: {                  // 铁律 3：全部必填注入，不藏默认
    identifiers,             // 标识词表（内置 {email,phone,username} 子集，非空）
    providers,               // OAuth provider 词表（可含自定义）
    challengeKinds,          // 挑战词表（非空）
    realms,                  // realm 词表（须含消费方全部 realm，写读双路径 fail-closed）
    passwordPolicy,          // { min, max, validate? }
    challenge: { digits, ttlMs, cooldownMs, maxAttempts, bounds },   // 发码缺省 + 覆盖上界
    codePepper,              // 挑战/恢复码 HMAC pepper（服务端密钥，装配注入）
    totp: { issuer, stepSec, windowSteps, recoveryCount },
    sessions: Record<realm, { issuer, secret, ttlSec }>,             // 每 realm 独立密钥/issuer
  },
  mailer?,                   // 缺省 = 邮件通道 fail-closed（undeliverable）
  captcha?,                  // 人机验证 port；缺省 = captcha 动词 unavailable
  sessionRevocation?,        // jti 黑名单 port；缺省 = 无 jti 拒绝面（仅锚点线）
  oauthStateStore?,          // OAuth state port；缺省 = oauth 动词不可用
  cipher?,                   // TOTP secret 落库加密（装配注入 runtime.createCipher 产物）
  auditSink?,                // 缺省 = 丢弃（无审计装配的面）；事件仍可观测（返回值不携带）
  store?,                    // 测试缝：缺省 postgres 适配器
}) => {
  credentials: { register },                        // 标识绑定（+可选首密码）
  passwords: { authenticate, change, reset },
  challenges: { begin, verify, abort },
  mfa: { enrollTotp, confirmTotp, verify, disableTotp },
  oauth: { findUser, link, unlink, authorize, callback },
  sessions: { sign, verify, validate, logout },
  revocation: { advance, revoke, validAt },
  captcha: { verify },
}
```

### 2.2 词表（封闭，单一真相 = 本包 domain）

- **identifierKind**：`email | phone | username`（内置闭集，配置只能收窄不能扩展——扩展 = 契约变更，须同步本节）。
- **challengeKind**：装配声明（v1 消费面：`user_login_code | user_register_code | admin_login_code`；机制对任意 kind 通用）。
- **realm**：装配声明（`^[a-z][a-z0-9_-]{1,31}$`；v1 消费面：`user | admin`）。写路径（revoke/advance）与读路径（validAt）同一白名单 fail-closed（B08 修复）。
- **OAuth provider**：装配声明；上游适配器内置 `github | google`（端点可注入覆盖），自定义 provider 由装配提供 `OAuthProvider` 实现注入。
- **audit 动作（封闭词表 14 项，架构测试快照锁死）**：`credential.register | credential.replay | credential.authenticate | password.change | password.reset | challenge.begin | challenge.verify | challenge.abort | oauth.link | oauth.unlink | mfa.enroll | mfa.confirm | mfa.disable | session.revoke`（携带 actor/realm/targetId/result 上下文）。发射形态（§5.4 事务参与，收口审计合规轮修订）：有业务事务的动词在事务内经 `auditSink.record(tx, event)` 同事务写入（回滚即无审计行、写失败随事务回滚，不降级 best-effort）；无事务路径（authenticate/verify/abort/begin 投递成功后）独立连接单写、失败上抛不吞错。
- **redirect_uri 白名单**：装配必填 `oauthRedirectAllowlist`（绝对 http(s) URL、无 query/fragment、去重校验），authorize 与 callback 两半程精确匹配、词表外 fail-closed 拒绝（invalid_input）——防授权码截断/开放重定向；归属 identity（apps 只透传注入）。
- **出口收敛**：存储 port 契约（CredentialStore/ChallengeStore/MfaStore/OAuthStore/AnchorStore，方法首参 DbLike）仅从 `./composition` 子入口导出，根出口零 Db 形态泄漏（架构测试锁死）。

词表封闭性由测试快照锁死；新增条目 = 契约变更，须同步本节。

### 2.3 错误目录（`identity.*`，AGENTS.md §11）

| 码                            | category      | 语义                                                                                                  |
| ----------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `invalid_input`               | invalid_input | 参数形状非法（缺字段/类型错）                                                                         |
| `unknown_identifier_kind`     | invalid_input | 标识 kind 不在词表（context 带 allowed）                                                              |
| `unknown_provider`            | invalid_input | provider 不在词表                                                                                     |
| `unknown_challenge_kind`      | invalid_input | 挑战 kind 不在词表                                                                                    |
| `unknown_realm`               | invalid_input | realm 不在词表（写读双路径同口径，B08）                                                               |
| `invalid_identifier`          | invalid_input | 标识归一化失败（形状/长度）                                                                           |
| `invalid_user_id`             | invalid_input | 主体 id 非正整数                                                                                      |
| `invalid_subject`             | invalid_input | OAuth subject 形状非法                                                                                |
| `weak_password`               | invalid_input | 密码不满足策略（context 带 reason）                                                                   |
| `invalid_credentials`         | forbidden     | 认证失败统一口径（防枚举：未知标识与错密码同码同文案）                                                |
| `identifier_taken`            | conflict      | 标识已被他人占用                                                                                      |
| `challenge_invalid`           | invalid_input | 挑战不存在/已消费/已作废/已过期（不细分死因）                                                         |
| `code_invalid`                | invalid_input | 码错误且尚有余次（context 带 remainingAttempts）                                                      |
| `challenge_cooldown`          | rate_limited  | 同 kind 同目标冷却中（context 带 retryAfterMs）                                                       |
| `undeliverable_challenge`     | unavailable   | 目标无对应投递器/无可投递凭据（fail-closed，B12）                                                     |
| `delivery_failed`             | unavailable   | 投递动作失败（挑战已作废，可立刻重发）                                                                |
| `oauth_link_not_found`        | not_found     | 绑定关系不存在                                                                                        |
| `provider_already_linked`     | conflict      | 绑定冲突（context 带 conflict: provider_identity_taken \| user_already_linked）                       |
| `last_credential`             | forbidden     | 最后凭据不可解绑（安全约束）                                                                          |
| `totp_not_enrolled`           | forbidden     | 未注册/挂起中即验证或禁用                                                                             |
| `totp_already_enrolled`       | conflict      | 已确认后再注册                                                                                        |
| `invalid_totp_code`           | forbidden     | TOTP/恢复码错误统一口径                                                                               |
| `invalid_token`               | forbidden     | 会话令牌验签失败/过期/跨 realm（context 带 reason: invalid_token \| token_expired \| realm_mismatch） |
| `captcha_invalid`             | invalid_input | 人机验证未通过（客户端过错）                                                                          |
| `captcha_unavailable`         | unavailable   | 人机验证服务不可用（fail-closed）                                                                     |
| `oauth_state_invalid`         | invalid_input | state 不存在/已消费/不匹配                                                                            |
| `oauth_provider_unconfigured` | not_found     | provider 未配置凭据                                                                                   |
| `oauth_profile_failed`        | unavailable   | 上游 token 交换/profile 拉取失败                                                                      |

内部不变量破坏（不可能分支）不经目录，直接抛 `@tillgate/errors` 的 `DefectError`（operation/detail 上下文）——v1 `identity_internal` 的 v2 归宿。

### 2.4 会话令牌契约（消费方 = apps 的 Bearer 中间件）

- 载荷：`{ realm, sub, jti(uuid), iss, exp, iat, iatMs }`；`iatMs` 毫秒精度自定义声明（亚秒级失效线锚点）。
- 算法 HS256 白名单 + issuer 按 realm 强校验 + 载荷 realm 双保险比对（三重隔离，v1 语义）；realm 密钥/issuer 独立（user/admin 互不认账）。
- TTL 每 realm 装配注入（v1 消费值 86400s）。
- `validate` 链：验签 → jti 黑名单（缺省无此面；读故障 fail-open + warn）→ 锚点线（`iatMs >= invalid_before`，无锚点=全有效）。**属主 status 回查不在本包**（§1）。

### 2.5 挑战参数域（缺省 + 覆盖上界，v1 语义）

6 位数字码 / TTL 300s / 冷却 60s / 错次上限 5（每次 begin 可覆盖，越界拒绝：ttl 1s..1h、cooldown 0s..1h、maxAttempts 1..100、digits 6..8）；哈希 = `HMAC-SHA256(codePepper, code:challengeId)`（B13 修复——v1 无 pepper 的 sha256 对 6 位码空间可秒级离线枚举）；payload ≤4KB 且 JSON 可序列化；投递上下文（ip/locale）只随 begin 入参内存流动（投递成功即弃），不与业务 payload 同行落库（v2 实测口径修正——挑战行只存业务 payload）。

### 2.6 密码哈希格式（单一形态，铁律 8）

`scrypt:N:r:p:<salt32hex>:<hash64hex>`（N=32768/r=8/p=1 自描述参数；历史 N=16384 哈希按行内参数可验）。v1 生产 `users.password_hash` 为 `salt:hash:N:r:p` 段序——**不双格式兼容**，切换时经机械格式转换迁移（MIGRATION §6）。

## 3. 并发与性能预算

- 发码在 advisoryLock（`pg_advisory_xact_lock(hashtext(key))`，key 归本包构造：`identity.challenge:{kind}:{target}` / `identity.user:{userId}`）内做「冷却判定 + 替换旧挑战 + INSERT」原子决策；验码是单条 CAS UPDATE（计错 + 命中即消费），无读改写竞态（v1 challenge-concurrency 锁定，real PG 门禁复验）。
- 挑战域时间单源 = DB `clock_timestamp()`（判定与 retryAfterMs 同钟，B14 修复）；锚点/JWT iat/审计 = 注入 clock；两域不互比（B15 口径）。
- changePassword 全判定（验旧密 + 换哈希 + 推锚点）收进 advisoryLock 临界区同一事务（B04 修复）；scrypt 在锁内执行（每用户锁，无全局争用）。
- 密码校验 CPU 预算：scrypt N=2^15 单次 ~50ms 级；哑哈希路径保证不存在账号与错密码同耗时量级（防时序枚举，v1 语义）。
- OAuth state：Redis 单值 SETEX + GETDEL 单次消费（不可达 = fail-closed 拒绝，v1 语义）。
- 无跨请求内存状态：v1 login-challenge 的模块级投递上下文 Map 移入挑战行 payload（B05 根治）。

## 4. 端口与适配器

| port                                                                             | 实现                                  | 说明                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CredentialStore` / `ChallengeStore` / `MfaStore` / `OAuthStore` / `AnchorStore` | `adapters/postgres/*`                 | 五聚合持久化 port，每动词 `db: DbLike` 首参参与调用方事务；SQL 与 v1 逐语义对齐（CAS/锁/部分唯一索引语义不变） |
| `Mailer`                                                                         | `adapters/smtp/nodemailer-mailer.ts`  | `sendLoginCode(to, code, {ip, locale})`；渲染在 `templates/login-code-email.ts`（纯函数）                      |
| `Captcha`                                                                        | `adapters/turnstile/captcha.ts`       | siteverify POST（fetch 注入、超时注入）；invalid/unavailable 二分                                              |
| `SessionTokens`                                                                  | `adapters/jwt/jose-tokens.ts`         | jose HS256 签发/验签（§2.4 契约）                                                                              |
| `SessionRevocationStore`                                                         | `adapters/redis/revocation-store.ts`  | SETEX 至令牌自然过期；读 fail-open+warn、写上抛（B06 口径）                                                    |
| `OAuthStateStore`                                                                | `adapters/redis/oauth-state-store.ts` | save(TTL)/consume(GETDEL)                                                                                      |
| `OAuthProvider`                                                                  | `adapters/oauth/{github,google}.ts`   | authorizeUrl + exchangeCode+fetchProfile（fetch/端点注入）                                                     |
| `SecretCipher`                                                                   | 装配注入 `runtime.createCipher(key)`  | TOTP secret 落库加密（enc:v1 单一真相在 runtime）                                                              |
| `Clock` / `AuditPort` / `Logger`                                                 | 装配注入                              | 时间/审计/告警观察面                                                                                           |

## 5. 依赖白名单

- 编译依赖：`@tillgate/db`（schema/Db/DbLike/DbTx/runTx/advisoryLock/唯一冲突判别）、`@tillgate/errors`、`drizzle-orm`（仅 adapters/postgres）、`jose`（仅 adapters/jwt）、`nodemailer`（仅 adapters/smtp）。
- **禁止**：`http`（无 Hono/middleware——总纲 §3.1）、`runtime`（cipher/logger/clock 经 port 注入）、`ai`、一切业务能力包（accounts/billing/inference/control-plane/notifications/observability——防环，总纲 §5.2「identity 不反向依赖业务能力」）。
- domain 零 I/O；application 只依赖本包 domain/ports；`./composition` 子入口只导出事务参与 bridge（同事务注册凭据等），`DbTx` 不进根 facade；Redis 客户端以结构化最小接口（`{ set/get/getDel/del }`）进入 adapter，不编译依赖 ioredis。

## 6. 测试边界

- 默认门禁（无真实凭证/无 PG）：domain 纯函数（scrypt 往返/格式、TOTP RFC 向量、标识归一矩阵、码哈希向量、会话契约）、application 用例（内存 store 模拟 CAS/冷却/替换/单调锚点）、SMTP 渲染、Turnstile/OAuth provider（注入 fetch）、错误目录快照、架构分层门禁。
- 真实 PG（`postgres.real.test.ts`，`test:real` 显式运行）：挑战 CAS 并发单赢家、部分唯一索引冷却、错次耗尽、锚点 GREATEST 单调与 realm 隔离、TOTP 步进 CAS 防重放、恢复码单次消费、OAuth 绑定并发单赢家、凭据并发注册单赢家、identity 七表 DDL fixture。
- 覆盖率阈值 90/85（lines/statements/functions 90、branches 85）；排除口径见 vitest.config.ts 注释。
- 测试目录平铺 `__test__/`（铁律 14；总纲 §3 树中 `test/{contract,postgres,security}/` 分组按铁律 14 收敛为平铺 + 文件名前缀区分，与 accounts/notifications 同款裁决）。
