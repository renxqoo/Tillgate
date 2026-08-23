# identity 迁移文档（MIGRATION.md）

> 状态：实施中
> 迁移单元：身份认证完整能力（凭据/密码/挑战/MFA/OAuth 绑定/会话与吊销的机制层）——一个可观察业务域，不是「一个包」的对拷
> 旧实现：/Users/wrr/work/ai-getway packages/identity-core（17 文件 ~2.6k 行，13 测试文件）+ packages/identity（9 文件 ~0.95k 行，6 测试文件）+ 两 app auth/oauth service 的机制语义（~1.6k 行，HTTP 编排不迁）
> 目标位置：packages/identity
> 关联：DESIGN.md / IMPLEMENTATION.md / 总纲 §3.4（凭据单一事实源纪律）

---

## 0. 测试迁移总矩阵（旧文件 → 新去处）

| 旧测试（identity-core）                 | 新去处                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| authenticate.test.ts（5 用例）          | application-passwords.test.ts                                                 |
| challenge.test.ts（15 用例）            | application-challenge.test.ts                                                 |
| challenge-concurrency.test.ts（5 用例） | concurrency.test.ts（内存）+ postgres.real.test.ts（真实 PG）                 |
| credentials.test.ts（6 用例）           | application-credentials.test.ts（tx 注入用例改经 composition bridge 断言）    |
| error-contract.test.ts（3 用例）        | errors.test.ts（目录快照形态）                                                |
| mfa.test.ts（9 用例）                   | application-mfa.test.ts                                                       |
| oauth.test.ts（11 用例）                | application-oauth.test.ts                                                     |
| password.test.ts（9 用例）              | domain-password.test.ts                                                       |
| passwords-change.test.ts（6 用例）      | application-passwords.test.ts                                                 |
| revocation.test.ts（6 用例）            | application-revocation.test.ts                                                |
| security.test.ts（5 用例）              | domain-password/domain-identifier/domain-challenge/application-challenge 分担 |
| totp.test.ts（7 用例）                  | domain-totp.test.ts                                                           |
| validation.test.ts（9 用例）            | domain-identifier.test.ts                                                     |

| 旧测试（identity 包）             | 新去处                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| session.test.ts（10 用例）        | application-session.test.ts + domain-session.test.ts（cookie 名用例删除——B02 死代码）   |
| login-challenge.test.ts（8 用例） | application-challenge.test.ts（kind 映射改词表直配；投递上下文断言改行内 payload）      |
| captcha.test.ts（8 用例）         | adapters-turnstile.test.ts（captchaFromEnv 三态用例删除——env 解析归 app）               |
| admin-session.test.ts（7 用例）   | **删除**：锁定的是死代码（B02）；其身份隔离断言由 application-session 跨 realm 用例承接 |
| password.test.ts（11 用例）       | domain-password.test.ts（与 core 版合并去重）                                           |
| mailer.test.ts（4 用例）          | templates-login-code-email.test.ts                                                      |

| 旧测试（apps，auth 机制语义）                                                                             | 新去处                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| client-api auth.test.ts / auth-code.test.ts / oauth.test.ts；admin-api auth.test.ts / auth-routes.test.ts | **不迁**（HTTP 编排/wire 契约归 apps 波次 G2）；其覆盖的机制行为经 §1 留档对照 |

## 1. 行为规格基线（等价判定标准——apps 波次对照用留档）

机制层（本单元验收口径）= 旧 identity-core 13 个测试文件 + identity 包 5 个有效测试文件的全部用例（§0 矩阵逐条对号）。

apps 编排层语义（v1 现状留档，本单元不验收、apps 波次行为对照）：

1. **注册流**：registerEnabled 门 → per-IP 5 次/时（Redis 固定窗口，fail-closed）→ Turnstile（未配则跳过）→ 密码策略 → 邮箱占用 409 → hashPassword → 发注册码（payload 携哈希）→ verifyRegistration 建号+赠送幂等（失败不回滚）+签 token。
2. **登录流**：guardKey=sha256(email:ip) 双锁（Redis 不可达 503）→ 查号 → 哑哈希防枚举 → 失败计数×2（锁中 429 否则 401）→ 封禁 403（可探测性 B25 留档）→ emailCodeRequired（on/off/auto=SMTP 配置即强制）? 发登录码 : 直发 token。
3. **admin 面**：per-admin twoFactorEnabled 邮箱码二次（全局 mailer 缺失时置开关 400 fail-closed）；登录失败/2FA/成功三审计。
4. **validateSession 链**：验签 → jti 黑名单 → 属主回查（users/admins）→ status=NORMAL → iatMs ≥ 失效线 → null/401。**v2 拆分**：验签+jti+锚点线归本包 validate；属主回查+status 归 accounts 经 app 编排。
5. **OAuth 流**：providers 过滤 → authorize（state Redis 不可达 503；next 只收站内相对路径）→ callback（state 双提交 cookie 比对 + GETDEL 单次，不可达按过期 410）→ code 换 profile（GitHub /user+/user/emails primary+verified；Google userinfo email_verified）→ find-or-create（users_issuer_subject_uq 23505 兜底）→ 封禁 403 → 新号赠送幂等 → token 入 URL fragment 重定向。
6. **logout**：jti 入 Redis 黑名单（SETEX 至自然过期）；v1 revoke 裸 await（Redis 故障 500，B06 留档）。
7. **改密**：验旧密 → 新哈希+失效线原子更新 → 审计（client 有/admin 无 B09）→ 签新 token。

## 2. 审计结论（引用 IMPLEMENTATION.md，不重复抄写）

影响本单元的真 bug：B01/B03/B04/B05/B08/B11/B12/B13/B14/B19/B20/B27 修复（回归用例见 IMPLEMENTATION §5）；B02 不移植；B07/B22/B25/B26 归 apps（§1 留档）；B21/B23/B24 接受并留档。重复提取 D1-D7、契约缺口 G1-G4 见 IMPLEMENTATION §1.2/§1.3。

## 3. 逐模块裁决表

见 IMPLEMENTATION.md §2（26 行裁决表，此处不重复）。

## 4. API 对照

| 旧签名（v1）                                                           | 新签名（v2 facade）                                                                                                                                     | 变化理由                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| createIdentity(db, options) → 16 动词平铺                              | createIdentity({db, txRetry, clock, logger, config, mailer?, captcha?, sessionRevocation?, oauthStateStore?, cipher?, auditSink?, store?}) → 七命名空间 | 六边形装配（accounts/notifications 同款）；动词按域分组                 |
| registerCredential({kind, value, userId, passwordHash?, tx?})          | credentials.register({kind, value, userId, passwordHash?})                                                                                              | tx 注入移除（facade 零 DbTx，B16）；同事务场景走 ./composition          |
| authenticate({kind, value, password})                                  | passwords.authenticate({kind, value, password})                                                                                                         | 归域分组；返回 {userId} 不变                                            |
| changePassword({userId, currentPassword, newPassword})                 | passwords.change({userId, currentPassword, newPassword})                                                                                                | 验旧密入锁内（B04）                                                     |
| resetPassword({userId, newPassword, passwordHash?})                    | passwords.reset({userId, newPassword})                                                                                                                  | 入参收窄（哈希由本包计算）                                              |
| beginChallenge({kind, target, payload?, overrides?})                   | challenges.begin({kind, target, payload?, overrides?}) + 投递上下文入 payload.delivery                                                                  | B05 根治；返回 {challengeId, code, expiresAt} 不变                      |
| verifyChallenge({challengeId, code, expectTarget?})                    | challenges.verify({challengeId, code, expectTarget?})                                                                                                   | expectTarget 语义保留（v1 expectEmail 泛化）                            |
| abortChallenge({challengeId})                                          | challenges.abort({challengeId})                                                                                                                         | 不变                                                                    |
| enrollTotp/confirmTotp/verifyMfa/disableTotp                           | mfa.enrollTotp/confirmTotp/verify/disableTotp                                                                                                           | 不变（verifyMfa → verify）                                              |
| findOAuthUser/linkOAuth/unlinkOAuth                                    | oauth.findUser/link/unlink                                                                                                                              | 不变                                                                    |
| （app 层）oauth.service.authorize/callback                             | oauth.authorize({provider, redirectUri, next?})/callback({provider, code, state})                                                                       | state 半程入包；cookie 双提交与重定向归 app（D7/G4）                    |
| signSession(input, secret)/verifySession(token, secret, type)          | sessions.sign({realm, subjectId, ttlSec?})/verify(token, realm)                                                                                         | realm 参数化（user/admin → 任意白名单 realm）；密钥装配注入不再随调用传 |
| （app 层）validateSession                                              | sessions.validate(token, realm)                                                                                                                         | 属主回查拆归 accounts（G2/DESIGN §1）                                   |
| （app 层）logout → revocationStore.revoke                              | sessions.logout(token)                                                                                                                                  | 入包；B06 口径                                                          |
| advanceAnchor(dbLike, realm, userId, at)/revokeSessions/sessionValidAt | revocation.advance({realm, userId, at?})/revoke({realm, userId})/validAt({realm, userId, iat})                                                          | 读路径 realm 白名单（B08）；advance 的 at 缺省 SQL now()（B28）         |
| hashPassword/verifyPassword/assertPasswordPolicy/PASSWORD_HASH_RE      | 导出保留（index.ts）                                                                                                                                    | 消费方（迁移脚本/apps）需要同一格式真相                                 |
| createLoginCodeChallenger(db, {mailer})                                | （删除）                                                                                                                                                | D4 并入 challenges.begin；kind 词表装配直配                             |
| createTurnstileCaptcha/captchaFromEnv                                  | adapters/turnstile（经 captcha port 注入）；FromEnv 归 app                                                                                              | B30                                                                     |
| createMailer/mailerFromEnv                                             | adapters/smtp + templates；FromEnv 归 app                                                                                                               | D6                                                                      |
| provision/provisionSql/deprovision/migrate-cli                         | （删除）                                                                                                                                                | D1：迁移链统一 @tokenlens/db（0076）                                    |
| 21 个错误类                                                            | identity.* 错误目录 + DefectError                                                                                                                       | ADR-0001；identity_internal → DefectError                               |

## 5. 测试迁移矩阵

见 §0（含删除理由：admin-session.test 锁定死代码 B02；captchaFromEnv/mailFromEnv 三态用例归 app 装配；cookie 名用例同 B02）。

## 6. 回滚方案

- **DDL 先行独立提交**：0076 全部语句 `create table/index if not exists` 幂等、无列变更、无数据迁移——revert 无需数据回滚（§9.1 迁移纪律）。
- **包主体独立提交**：v2 尚无 app 消费方（apps/ 为空），revert 即整体还原，无运行时影响。
- **v1 旧仓只读不新增**：切换验证前 v1 继续运行其自身体系（users 列 + Redis）；两套不双写（v2 七表生产为空，结构性无冲突——IMPLEMENTATION §1 关键结构性事实）。
- **存量数据迁移（apps 切换单元执行，非本单元）**：users/admins.password_hash `salt:hash:N:r:p` → identity_passwords `scrypt:N:r:p:salt:hash` 机械转换（同参 scrypt，重排段序，可逆）；session_invalid_before → 锚点行回填（realm user/admin 分列）；admins.two_factor_* 偏好迁移由 admin-api 波次裁决。in-flight 挑战（TTL 300s）与恢复码（生产为空）无需迁移。

## 7. 验收（全部满足才算完成）

- 四门全绿（typecheck/lint/test/build）；覆盖率 ≥ 90/85（排除口径见 vitest.config.ts）。
- 行为对照清单逐项核销：§0 矩阵 24 个旧测试文件全部对号（迁/并/删+理由）；IMPLEMENTATION §5 新测试 18 件全绿。
- 全部 bug 回归用例通过（B04/B05/B08/B11/B12/B13/B14/B19/B20/B27 各至少一例，用例名注明编号）。
- 架构门禁：index.ts 不泄 Db/DbTx/adapter/供应商类型；全包禁 hono/http/runtime/ai/业务能力包；真实 PG real 门禁（test:real）通过或环境缺失显式 skip。

## 8. 待办（后续波次，非本单元缺口）

| #   | 事项                                                                         | 归属波次                                 |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| W1  | users/admins 凭据列退役 DDL + 存量数据迁移脚本（§6）                         | apps 切换单元                            |
| W2  | 注册/登录 HTTP 编排（限流/防暴破/封禁探测收敛/邮箱枚举策略）与 wire 契约     | client-api/admin-api 波次（§1 留档对照） |
| W3  | validateSession 属主回查编排（accounts status）                              | apps 波次                                |
| W4  | 恢复码离线枚举加固复核（HMAC pepper 已落，字母表熵 2^49.6 维持）             | 安全审计节点                             |
| W5  | B07 软锁真节流（锁定态短路 scrypt/DB 的 DoS 取舍）                           | apps 装配（需 ADR）                      |
| W6  | SMS 通道投递器（phone 目标现仅邮件通道 fail-closed 语义占位——v1 同为未实现） | 需求出现时                               |
