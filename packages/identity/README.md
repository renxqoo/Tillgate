# @tokenlens/identity

> 身份认证能力:凭据、密码、统一挑战、MFA、OAuth 绑定、JWT 会话与吊销(总纲 §3/P4.1)。
> 设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 迁移核销 [MIGRATION.md](./MIGRATION.md)

一句话:认证秘密的唯一所有者——标识↔主体绑定、密码、验证码挑战、TOTP、OAuth 绑定、
JWT 会话与吊销线;不建用户资料行(userId 由 accounts 分配),会话校验只验
「签 + jti + 锚点线」,不回查资料(防环,§5.2)。

## 核心导出面

- `createIdentity(params)` facade → `Identity` 八组动词:
  `credentials`(注册标识绑定)/ `passwords`(authenticate/change/reset)/
  `challenges`(begin/verify/abort——码只存 HMAC(pepper) 哈希,一次性消费、错次上限、
  同 kind 冷却)/ `mfa`(TOTP 两段注册 + 恢复码)/ `oauth`(link/unlink/authorize/callback,
  GitHub/Google 内置适配)/ `sessions`(sign/verify/validate/logout——HS256 双 realm
  user/admin 令牌)/ `revocation`(advance/revoke/validAt)/ `captcha`(Turnstile,
  fail-closed)。
- **会话失效线单一真相源**:吊销锚点表 `identity_session_anchors`(GREATEST 单调,
  realm 泛化)——v1 双库分裂收敛于此;accounts 的 `SessionInvalidationPort` 桥接此线。
- 领域纯函数与词表:`hashPassword` / `verifyPassword`(scrypt)/ `assertPasswordPolicy`、
  identifier 归一化、`renderLoginCodeEmail`(中英双语验证码邮件模板)、
  `AUDIT_ACTIONS` 审计动作词表。
- ports(根入口类型):`Mailer` / `Captcha` / `SecretCipher`(TOTP secret 加密)/
  `SessionTokens` / `OAuthProvider` / `SessionRevocationStore`(jti 黑名单)等——
  缺省即对应动词 unavailable(fail-closed),postgres store / jose 令牌为内置缺省实现。
- `identityErrors` 错误目录;`./composition` 子入口(仅 assembly / accounts adapter):
  存储port 契约与**同事务桥**(建号 + 挂标识原子:accounts 建号用例与 credential
  写入同一 DbTx)。

## 目录结构

```
src/
├── identity.ts      # createIdentity facade:内置适配器组装 + 八组动词收敛
├── application/     # 用例层:register/authenticate/challenge/mfa/oauth/session/revocation
├── domain/          # 领域纯函数:identifier/password/challenge/session/audit-events/config
├── adapters/        # postgres identity-store / jose 令牌 / oauth(github、google)
├── ports/           # 可替换契约:各 store/clock/logger/mailer/captcha/cipher
├── templates/       # 验证码邮件模板(login-code-email)
├── testing/         # 测试替身/装置
├── composition.ts   # 装配子入口(存储 port + 同事务桥,非公开 API)
└── index.ts         # 唯一公共出口(零 Db/DbTx 形态泄漏)
```

## 装配

消费方:`apps/client-api` 与 `apps/admin-api` 的 `src/assembly.ts`(user/admin 双
realm;client-api 另装配 Redis 侧 jti 黑名单 / OAuth state / Turnstile / SMTP mailer
适配器)。gateway 经 accounts 的 `SessionInvalidationPort` 间接消费吊销线。

## 开发

```bash
cd packages/identity
bun run typecheck && bun run lint && bun run test
DB_TEST_URL=postgres://... bun run test:real   # postgres.real.test.ts 真库门(缺 env 整组 skip)
```
