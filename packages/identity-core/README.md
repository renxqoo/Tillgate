# @ai-gateway/identity-core — 通用身份内核

业务无关的身份组件：**凭据绑定、统一挑战（验证码）、OAuth 绑定、TOTP+恢复码、会话吊销锚点**。
与 `@ai-gateway/wallet` 同一套工程哲学——不变量全部下沉数据库、动词单一职责、类型化错误、
三张必填白名单 fail-closed、可整体目录拎出独立仓复用（电商/内容平台同构）。

## 一句话心智模型

> **wallet 管「钱的真实」，identity-core 管「人的真实」。**
> 你自带 users 表（余额、套餐、昵称都是你的），本包只认你分配的 `userId`，
> 替你把「谁能登录、码只能用一次、改密全网下线」这些安全事实管到数据库级。

## 与旧 `@ai-gateway/identity` 的分工（零改动共存）

| | 旧 identity | identity-core（本包） |
|---|---|---|
| 管什么 | 无状态算法：JWT 签验、cookie、scrypt、Redis 限流 | 有状态安全事实：凭据/挑战/绑定/锚点 |
| 拥有表 | 无 | `identity_*` 七表 |
| 改造 | **不动** | 新包，gateway 未接线 |

哈希格式逐字兼容（`scrypt:N:r:p:<saltHex>:<hashHex>`）：未来迁移 `users.password_hash` 原样搬迁即可继续校验。

## 快速开始

```ts
import { createIdentity, provision, hashPassword } from '@ai-gateway/identity-core';

await provision(db); // 一次性建七表（幂等）；或 provisionSql() 收进你自己的迁移管线

const identity = createIdentity(db, {
  identifiers: ['email'],                        // 必填白名单：允许的标识类型
  providers: ['github', 'google'],               // 必填白名单：允许的 OAuth provider
  challenges: ['email_code', 'email_verification', 'password_reset'], // 必填白名单：挑战类型
  password: { minLength: 10 },                   // 可选策略
  challenge: { digits: 6, ttlMs: 300_000, cooldownMs: 60_000, maxAttempts: 5 },
  totp: { issuer: 'ai-gateway' },
  effects: {
    deliver: async ({ channel, to, kind, code }) => mailer.send(to, code), // 验证码出境唯一通道
    audit: async (e) => auditLog.write(e),                                  // 尽力而为
  },
});
```

## 18 个动词（一动词一事）

```
凭据   registerCredential({tx?, userId, identifier, passwordHash?})   挂标识（唯一索引兜底并发；同人重挂=幂等重放）
       authenticate({identifier, password}) → {userId}               恒定时间+统一错误（防枚举在包内）
       changePassword({userId, currentPassword, newPassword})        验旧密 → 换哈希+吊销线（同事务）
       resetPassword({userId, newPassword})                          找回/管理员重置，免旧密，同样推进吊销线
挑战   beginChallenge({kind, target, payload?}) → {challengeId, code} 发码（冷却/替换/哈希落库）
       verifyChallenge({challengeId, code}) → {target, payload}      一条 UPDATE 完成计错+消费（CAS）
       abortChallenge({challengeId})                                 幂等作废
OAuth   findOAuthUser({provider, subject}) → userId | null
       linkOAuth({tx?, userId, provider, subject, email?})           (provider,subject) 全局唯一=防劫持
       unlinkOAuth({userId, provider})                               凭据集守卫：删后必须仍可登录
MFA    enrollTotp({userId, label?}) → {secret, otpauthUrl}           挂起注册（重挂=换新密钥）
       confirmTotp({userId, code}) → {recoveryCodes}                 首码确认+恢复码（明文只此一次）
       verifyMfa({userId, code}) → {method}                          TOTP 步进单调防重放 / 恢复码单次消费
       disableTotp({userId, code?})                                  已确认必须验码
吊销   revokeSessions({userId, at?}) → {invalidBefore}               GREATEST 单调推进
       sessionValidAt({userId, iat}) → boolean                       无锚点=全有效
```

## 使用示例

### 邮箱注册两步流（密码哈希随挑战存——验码前不建号）

```ts
// 第一步：发码（人机验证/IP 限流是你的策略，留在你那边）
const { challengeId } = await identity.beginChallenge({
  kind: 'email_verification',
  target: { identifier: { kind: 'email', value: email } },
  payload: { passwordHash: await hashPassword(password) },
});
// code 已经 effects.deliver 发到用户邮箱

// 第二步：验码 → 建你的 user 行 + 挂凭据（同一事务，tx 注入）
const v = await identity.verifyChallenge({ challengeId, code });
const userId = await db.transaction(async (tx) => {
  const [u] = await tx.insert(users).values({ displayName }).returning();
  await identity.registerCredential({
    tx,
    userId: u.id,
    identifier: v.target.identifier!,
    passwordHash: (v.payload as { passwordHash: string }).passwordHash,
  });
  return u.id;
});
const token = signSession({ sub: userId }); // JWT 签发仍用旧 identity 工具
```

### 登录（密码 + 邮箱码两步）与改密全网下线

```ts
const { userId } = await identity.authenticate({ identifier: { kind: 'email', value: email }, password });
const { challengeId } = await identity.beginChallenge({ kind: 'email_code', target: { userId } });
// ... 验码后签会话；JWT 校验中间件追加一行：
if (!(await identity.sessionValidAt({ userId, iat: payload.iat * 1000 }))) throw new Unauthorized();
// 改密码（包内同事务换哈希+推锚点，旧会话全部失效）：
await identity.changePassword({ userId, currentPassword: old, newPassword: next });
```

### 密码找回（挑战家族的一种 kind，白得的能力）

```ts
const { challengeId } = await identity.beginChallenge({ kind: 'password_reset', target: { identifier: { kind: 'email', value: email } } });
const v = await identity.verifyChallenge({ challengeId, code });
await identity.resetPassword({ userId: resolveUserId(v.target), newPassword }); // 自动全网下线
```

### 电商独立用（业务无关证明）

```ts
const shop = createIdentity(shopDb, {
  identifiers: ['phone', 'email'],
  providers: ['wechat'],
  challenges: ['sms_code', 'password_reset'],
  effects: { deliver: ({ channel, to, code }) => channel === 'sms' ? sms.send(to, code) : mailer.send(to, code) },
});
```

## 数据模型（七表，本包私有，不 FK 到你的 users）

| 表 | 职责 | 关键不变量（DB 级） |
|---|---|---|
| `identity_credentials` | 标识↔userId（email/phone/username 归一形态） | `UNIQUE(kind,value)`=一个标识一个账号 |
| `identity_passwords` | 密码哈希（一人一行，与标识解耦） | 格式自描述（scrypt:N:r:p:salt:hash） |
| `identity_oauth_links` | 三方绑定 | `UNIQUE(provider,subject)` 防劫持 + `UNIQUE(user_id,provider)` |
| `identity_challenges` | 统一挑战 | XOR 目标 CHECK；`attempts<=max_attempts` CHECK；终态互斥 CHECK；部分唯一索引「同 kind 同目标至多一条活挑战」；码只存 `sha256(code:challengeId)` |
| `identity_totp` | MFA（confirmed_at 挂起→生效） | `last_used_step` 单调 CAS 防重放 |
| `identity_recovery_codes` | 恢复码 | 只存哈希；`UNIQUE(user_id,code_hash)`；单次消费 |
| `identity_session_anchors` | 吊销锚点（一人一行） | `GREATEST` 推进=单调不后退 |

**应用层不变量（advisory lock 串行实现）**：凭据集非空（解绑/删密后必须仍留一种登录方式）——
跨表 CHECK 表达不了，用 `pg_advisory_xact_lock(user)` 把该用户全部凭据变更串行化，判定在临界区内完成。

## 防错故事（为什么这些不变量长这样）

- **码被截屏重放** → 验证是 CAS 单次消费：同码第二次吃 `ChallengeInvalidError`（不存在/已用/过期/超限统一口径，不泄露挑战状态）
- **撞库爆破验证码** → 错误尝试在 `max_attempts` 内递减（`CodeInvalidError(remaining)`），耗尽即死；attempts 越界被 DB CHECK 结构性禁止
- **刷验证码轰炸邮箱** → 同 kind 同目标活挑战唯一（部分唯一索引）+ 冷却；`cooldownMs=0` 时旧挑战原子替换（不会同时两条活码）
- **用户枚举** → `authenticate` 恒定时间（哑哈希补齐耗时）+ 同一个错误同一个文案
- **改密后旧 JWT 还能用** → 改密/重置同事务推进吊销线，`sessionValidAt` 一行接入你的校验链
- **三方账号劫持** → (provider, subject) 全局唯一；邮箱不跨身份自动合并
- **盗会话者直关 MFA** → `disableTotp` 已确认态必须携有效码
- **TOTP 码重放/旧码重用** → `last_used_step < step` 单调 CAS
- **发码后 SMTP 挂了** → `deliver` 失败立即作废挑战并抛 `DeliveryFailedError`——发不出去=流程没发生，冷却已让位可立即重发

## 设计边界（消费方须知，刻意为之）

- **本包不建用户行**：userId 由你分配；建号+挂凭据要原子就传 `tx`（`registerCredential`/`linkOAuth` 支持）
- **账号状态（封禁/注销）是你的域**：登录期状态检查由你在 `authenticate` 之后做
- **限流/人机验证是你的策略**：Redis 计数、Turnstile 都在包外（旧 identity 有现成工具）
- **JWT 签发不收进来**：本包只管吊销锚点；无状态签验继续用旧包，边界零重叠
- **挑战到期/冷却判定用 PG 时钟**（`clock_timestamp()`）：应用服务器时钟不参与安全判定
- **TOTP 密钥静态加密可选**（`totpSecretCipher`）：不配则明文存储——生产建议注入 AES-GCM cipher

## 测试（102 例 / 13 文件，全部打真 PG）

独立 schema 建删（globalSetup）、文件级串行、每文件池 max 3。覆盖：
密码哈希（RFC 兼容格式/哑哈希）· TOTP（RFC 6238 官方向量）· 白名单守卫 · 凭据（并发/重放/事务回滚）·
认证（防枚举契约/脏哈希）· 改密重置（吊销线联动）· 挑战（生命周期/冷却替换/投递失败/目标寻址）·
挑战并发（单次消费/同目标串行）· OAuth（防劫持/凭据集守卫/并发绑定解绑）· MFA（重放/恢复码/加密）·
吊销（单调/边界）· 错误契约（21 类 code 唯一）· 安全专项（机密不落明文/洪水输入/配置 fail fast）。
