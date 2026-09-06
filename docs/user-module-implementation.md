# User 模块实现文档

> 架构基线:纯 TypeScript + Hono + function-first + 事件驱动(PostgreSQL 事实源 / Redis 缓存与队列 / BullMQ Worker)。
> 状态:参考实现文档(实现指南 + 验收基准)。
> 约定:文件 kebab-case;注释只解释契约与不变量;`import type` 导入类型;strict TS,禁 `any`/非空断言。

---

## 0. 与本仓库(Tillgate)的关系

本文档是**按上述架构从零实现 User 模块的完整参考实现**,用独立的代码路径表述
(`shared/` + `modules/user/` + `apps/api` + `apps/worker`)。

Tillgate 中已有对应能力,落地时优先复用而非平行新建:

| 文档中的位置 | Tillgate 现状 |
|---|---|
| `modules/user/domain` | `packages/accounts/src/domain/user.ts`、`status.ts`、`credentials.ts` |
| `modules/user/application` | `packages/accounts/src/application/*`(一用例一文件) |
| `modules/user/ports` | `packages/accounts/src/ports/account-store.ts` 等 |
| `modules/user/adapters` | `packages/accounts/src/adapters/postgres/users.ts` |
| 登录/会话/令牌 | `packages/identity`(challenge、MFA、OAuth、jose JWT) |
| 表定义与迁移 | `packages/db/src/schema/users.ts` + `packages/db/migrations` |
| 事件/outbox | `packages/notifications`(outbox 模式) |
| Worker | `apps/worker`(BullMQ jobs/queue/scheduler) |
| 错误目录 | `packages/errors`(`defineErrorCatalog` 体系) |

若目标是"在本仓库补齐 user 能力",把本文的状态机、端口与事件契约当作设计基准,
代码落在上述包内;若目标是新服务,可按本文目录直接搭建。

---

## 1. 目标与非目标

### 1.1 目标(本模块负责)

- 注册:邮箱 + 密码建号,发出验证邮件(事件驱动,不阻塞 HTTP)。
- 邮箱验证:一次性 token,消费后 `pending → active`。
- 登录:密码校验 + 锁定策略,签发 access(JWT)+ refresh(opaque,Redis)。
- 会话:refresh 轮换 + 重放检测;登出;改密全端失效。
- 资料:查询 / 改昵称 / 改密码。
- 注销:软删除,延迟清理(合规窗口)。
- 对外发布领域事件:`UserRegistered` / `UserEmailVerified` / `UserPasswordChanged` / `UserDeactivated`。

### 1.2 非目标(明确不做)

- OAuth / MFA / 魔法链接登录(归 identity 域,本模块只留 `identityProvider` 扩展点)。
- RBAC、组织、多租户(归 accounts 域)。
- Admin 管理面(列表、封禁、改状态)。
- 密码找回(流程与邮箱验证同构,可按同一模式追加,本文不展开)。

---

## 2. 架构总览

### 2.1 模块位置

```
                       Node.js
             ┌─────────┴─────────┐
             ▼                   ▼
        apps/api(Hono)     apps/worker(BullMQ)
          解析/校验/映射        事件消费/延迟任务
             └─────────┬─────────┘
                       ▼
                modules/user            ← 本模块
             ┌─────────┼──────────────┐
             ▼         ▼              ▼
        application  domain      infrastructure
        (usecase)   (纯函数)     ports 的实现:
                      │          PostgreSQL / Redis /
                      │          MQ(outbox→BullMQ)/ SMTP
                      └─ domain 不依赖任何一层、任何技术
```

### 2.2 依赖铁律

```
http / worker ──→ application ──→ domain
                     ↑ 定义 port    ↑
                     └─ adapters 实现 port(依赖倒置)
```

1. `domain.ts` 零 import(连 zod 都不许)。
2. `application` 只 import `domain` + `ports` 类型 + shared kernel;不出现 HTTP/MQ/PG 概念。
3. `adapters` 实现端口;不含业务判断。
4. 跨模块只准 import 对方的 application(或事件类型),禁止摸对方的 domain/adapters。
5. 依赖方向由 `architecture.test.ts`(或 dependency-cruiser)固化,违反即测试失败。

### 2.3 关键数据流

**注册(同步链只有一步,发信异步):**

```
POST /v1/users
  → register(ctx, cmd)                     [application, withTx]
      ├─ INSERT users (status=pending)
      ├─ INSERT email_verifications (token hash, TTL 24h)
      └─ INSERT outbox (UserRegistered)
  ← 202 { userId }
worker: UserRegistered → SMTP 发验证邮件(processed_events 幂等)
```

**登录:**

```
POST /v1/auth/login
  → login(ctx, cmd)
      ├─ Redis 限流(IP + email 双维度)
      ├─ SELECT user by email(citext)
      ├─ argon2id verify(用户不存在时 dummy verify,恒定耗时防枚举)
      ├─ domain.authenticate(锁定计数/清零)
      ├─ JWT access(15m)+ refresh(Redis,30d,family 绑定)
      └─ UPDATE users(lastLoginAt, failedAttempts)
  ← 200 { accessToken, refreshToken, user } | 401 USER_INVALID_CREDENTIALS(统一响应)
```

**改密(全端失效走事件):**

```
POST /v1/me/password → changePassword(tx) ─┬─ UPDATE users (passwordHash, version+1)
                                           └─ outbox (UserPasswordChanged)
worker: UserPasswordChanged → revoke 该用户全部 refresh family
```

---

## 3. 目录与文件清单

```
src/
├── apps/
│   ├── api/                        # Hono 入口(组合根 A)
│   │   ├── config.ts               # zod 解析环境变量
│   │   ├── assembly.ts             # 装配 ctx + 各模块 service
│   │   ├── http/
│   │   │   ├── error-mapper.ts     # 错误码 → HTTP 唯一映射点
│   │   │   ├── auth-middleware.ts
│   │   │   └── routes/user.ts
│   │   └── index.ts
│   └── worker/                     # BullMQ 入口(组合根 B)
│       ├── assembly.ts
│       ├── handlers/user-events.ts
│       ├── outbox-relay.ts
│       └── index.ts
├── shared/
│   ├── ctx.ts                      # Ctx / Tx 类型, withTx
│   ├── result.ts                   # Result / ok / err
│   └── events.ts                   # DomainEvent, Outbox 端口, relay
└── modules/
    └── user/
        ├── domain.ts               # 状态机 + 纯函数(零依赖)
        ├── ports.ts                # UsersRepo / Hasher / Tokens / RefreshStore / Mailer / ...
        ├── service.ts              # createUserService:全部 usecase
        ├── adapters/
        │   ├── pg-users.ts         # drizzle/sqlc 风格仓库实现
        │   ├── pg-verifications.ts
        │   ├── redis-refresh.ts    # refresh family + 重放检测
        │   ├── redis-limiter.ts
        │   ├── argon2-hasher.ts
        │   ├── jose-tokens.ts
        │   └── smtp-mailer.ts
        └── events.ts               # UserEvent 联合 + 类型守卫(供 worker/他域引用)
```

交付物清单(实现完成的定义):

- [ ] migration SQL × 3(users、email_verifications、共享 outbox/processed_events 若不存在)
- [ ] `domain.ts` + 表驱动单测
- [ ] `ports.ts`、`service.ts` + Testcontainers 集成测试
- [ ] adapters × 7
- [ ] HTTP 路由 + 错误映射 + 限流中间件
- [ ] worker handlers + outbox relay + 延迟清理 job
- [ ] 架构测试(依赖方向)+ 指标埋点

---

## 4. 数据模型

### 4.1 DDL(PostgreSQL,事实源)

```sql
-- 001_users.sql
CREATE TABLE users (
  id              text        PRIMARY KEY,              -- 前缀式 ULID,如 usr_01HXXXX
  email           citext      NOT NULL UNIQUE,          -- citext:大小写不敏感唯一
  password_hash   text        NOT NULL,                 -- argon2id PHC 字符串,永不投影
  nickname        text        NOT NULL CHECK (length(nickname) BETWEEN 1 AND 32),
  status          text        NOT NULL,                 -- pending | active | deactivated
  failed_attempts int         NOT NULL DEFAULT 0,
  locked_until    timestamptz,                          -- 账户锁定截止;NULL=未锁
  verified_at     timestamptz,
  last_login_at   timestamptz,
  deactivated_at  timestamptz,
  version         bigint      NOT NULL DEFAULT 1,       -- 乐观锁:每次 save 递增
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_status_created_idx ON users (status, created_at DESC);

-- 002_email_verifications.sql
CREATE TABLE email_verifications (
  token_hash  text        PRIMARY KEY,                  -- sha256(token),明文 token 只出现在邮件
  user_id     text        NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,                              -- NULL=未消费;一次性
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id, created_at DESC);

-- 003_outbox.sql(共享基础设施,若已存在则跳过)
CREATE TABLE outbox (
  event_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text        NOT NULL,                   -- 'UserRegistered' | ...
  payload       jsonb       NOT NULL,
  occurred_at   timestamptz NOT NULL,
  published_at  timestamptz                              -- NULL=待投递
);
CREATE INDEX outbox_pending_idx ON outbox (occurred_at) WHERE published_at IS NULL;

-- 幂等消费(共享)
CREATE TABLE processed_events (
  event_id     uuid        PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
```

### 4.2 不变量(数据库层兜底 + 域层声明)

- `email` 全库唯一(citext);唯一冲突 → `USER_EMAIL_TAKEN`。
- `status='pending'` 的行 `verified_at IS NULL`;`'active'` 则 `NOT NULL`(CHECK 可后补)。
- `password_hash` 永不出现在任何 SELECT 投影与日志(投影白名单见 8.1)。
- 行更新必须走乐观锁:`UPDATE ... WHERE id=$1 AND version=$2`,影响行数为 0 → 并发冲突错误。

### 4.3 drizzle 表定义片段(`packages/db/src/schema` 风格)

```ts
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname').notNull(),
  status: text('status').notNull().$type<'pending' | 'active' | 'deactivated'>(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

---

## 5. 领域层 `domain.ts`(完整实现)

> 零依赖。所有函数纯:入参 + 时钟,返回新值,不修改入参,不做 IO。

```ts
// modules/user/domain.ts

// ---------- 值对象 ----------
export type Brand<T, B extends string> = T & { readonly __brand: B }
export type UserId = Brand<string, 'UserId'>
export type Email = Brand<string, 'Email'>
export type PasswordHash = Brand<string, 'PasswordHash'>

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/

export function parseEmail(raw: string): Email | null {
  const v = raw.trim().toLowerCase()
  return EMAIL_RE.test(v) ? (v as Email) : null
}

// ---------- 错误(判别联合,机器可读码) ----------
export type UserError =
  | { code: 'USER_EMAIL_INVALID' }
  | { code: 'USER_PASSWORD_POLICY' }
  | { code: 'USER_EMAIL_TAKEN' }
  | { code: 'USER_ALREADY_VERIFIED' }
  | { code: 'USER_VERIFICATION_TOKEN_INVALID' }
  | { code: 'USER_INVALID_CREDENTIALS' }
  | { code: 'USER_LOCKED'; until: string }
  | { code: 'USER_DEACTIVATED' }
  | { code: 'USER_NOT_FOUND' }
  | { code: 'USER_CONFLICT' }          // 乐观锁/并发冲突
  | { code: 'USER_RATE_LIMITED' }

// ---------- 状态机 ----------
// pending --verifyEmail--> active --deactivate--> deactivated
// pending ------deactivate----→ deactivated
export interface UserCommon {
  id: UserId
  email: Email
  passwordHash: PasswordHash
  nickname: string
  failedAttempts: number
  lockedUntil: Date | null
  createdAt: Date
  updatedAt: Date
  version: number
}

export type User =
  | (UserCommon & { status: 'pending' })
  | (UserCommon & { status: 'active'; verifiedAt: Date; lastLoginAt: Date | null })
  | (UserCommon & { status: 'deactivated'; deactivatedAt: Date; reason: string })

export type ActiveUser = Extract<User, { status: 'active' }>

// ---------- 密码策略(域规则,与传输格式无关) ----------
// ≥10 ≤128 字符,至少两类字符;禁止与邮箱相同。
export function checkPasswordPolicy(pw: string, email: Email): UserError | null {
  if (pw.length < 10 || pw.length > 128) return { code: 'USER_PASSWORD_POLICY' }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(pw)).length
  if (classes < 2) return { code: 'USER_PASSWORD_POLICY' }
  if (pw.toLowerCase() === email.toLowerCase()) return { code: 'USER_PASSWORD_POLICY' }
  return null
}

// ---------- 注册 ----------
export interface RegisterInput {
  id: UserId
  email: Email
  nickname: string
  passwordHash: PasswordHash        // 哈希在应用层完成,域不依赖算法
  now: Date
}
export interface UserRegistered {
  type: 'UserRegistered'
  userId: string
  email: string
  nickname: string
  occurredAt: string                // ISO 串,保证 JSON 可序列化
}

export function register(input: RegisterInput): { user: User; event: UserRegistered } {
  const user: User = {
    status: 'pending',
    id: input.id,
    email: input.email,
    passwordHash: input.passwordHash,
    nickname: input.nickname,
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  }
  return {
    user,
    event: {
      type: 'UserRegistered',
      userId: input.id,
      email: input.email,
      nickname: input.nickname,
      occurredAt: input.now.toISOString(),
    },
  }
}

// ---------- 邮箱验证 ----------
export function verifyEmail(u: User, now: Date):
  { ok: true; user: User; events: [{ type: 'UserEmailVerified'; userId: string; occurredAt: string }] }
  | { ok: false; error: UserError } {
  if (u.status === 'deactivated') return { ok: false, error: { code: 'USER_DEACTIVATED' } }
  if (u.status === 'active') return { ok: false, error: { code: 'USER_ALREADY_VERIFIED' } }
  const active: User = {
    ...u,
    status: 'active',
    verifiedAt: now,
    updatedAt: now,
    version: u.version + 1,
  }
  return {
    ok: true,
    user: active,
    events: [{ type: 'UserEmailVerified', userId: u.id, occurredAt: now.toISOString() }],
  }
}

// ---------- 登录校验(锁定策略在域内) ----------
export const LOCK_THRESHOLD = 5
export const LOCK_DURATION_MS = 15 * 60 * 1000

export type AuthOutcome =
  | { outcome: 'authenticated'; user: User }                 // attempts 清零、lastLoginAt 更新
  | { outcome: 'bad-credentials'; user: User; locked: boolean } // attempts+1,可能触发锁定

export function authenticate(u: User, passwordOk: boolean, now: Date):
  { ok: true; data: AuthOutcome } | { ok: false; error: UserError } {
  if (u.status === 'deactivated') return { ok: false, error: { code: 'USER_DEACTIVATED' } }
  if (u.lockedUntil && u.lockedUntil > now)
    return { ok: false, error: { code: 'USER_LOCKED', until: u.lockedUntil.toISOString() } }

  if (!passwordOk) {
    // 域内决定计数与锁定,但不做 IO;持久化由应用层负责
    const failedAttempts = u.failedAttempts + 1
    const locked = failedAttempts >= LOCK_THRESHOLD
    return {
      ok: true,
      data: {
        outcome: 'bad-credentials',
        user: {
          ...u,
          failedAttempts: locked ? 0 : failedAttempts,   // 锁定即重置计数,解锁后重新累计
          lockedUntil: locked ? new Date(now.getTime() + LOCK_DURATION_MS) : u.lockedUntil,
          updatedAt: now,
          version: u.version + 1,
        },
        locked,
      },
    }
  }

  return {
    ok: true,
    data: {
      outcome: 'authenticated',
      user: {
        ...u,
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
        updatedAt: now,
        version: u.version + 1,
      },
    },
  }
}

// ---------- 改密 ----------
export function changePassword(
  u: User,
  input: { oldPasswordOk: boolean; newHash: PasswordHash },
  now: Date,
): { ok: true; user: User; events: [{ type: 'UserPasswordChanged'; userId: string; occurredAt: string }] }
  | { ok: false; error: UserError } {
  if (u.status === 'deactivated') return { ok: false, error: { code: 'USER_DEACTIVATED' } }
  if (!input.oldPasswordOk) return { ok: false, error: { code: 'USER_INVALID_CREDENTIALS' } }
  const user: User = { ...u, passwordHash: input.newHash, updatedAt: now, version: u.version + 1 }
  return {
    ok: true,
    user,
    events: [{ type: 'UserPasswordChanged', userId: u.id, occurredAt: now.toISOString() }],
  }
}

// ---------- 资料 ----------
export function updateNickname(u: User, nickname: string, now: Date):
  { ok: true; user: User } | { ok: false; error: UserError } {
  if (u.status === 'deactivated') return { ok: false, error: { code: 'USER_DEACTIVATED' } }
  if (nickname.length < 1 || nickname.length > 32) return { ok: false, error: { code: 'USER_EMAIL_INVALID' } }
  return { ok: true, user: { ...u, nickname, updatedAt: now, version: u.version + 1 } }
}

// ---------- 注销 ----------
export function deactivate(u: User, now: Date):
  { ok: true; user: User; events: [{ type: 'UserDeactivated'; userId: string; occurredAt: string }] }
  | { ok: false; error: UserError } {
  if (u.status === 'deactivated') return { ok: false, error: { code: 'USER_DEACTIVATED' } }
  const user: User = {
    ...u,
    status: 'deactivated',
    deactivatedAt: now,
    reason: 'self',
    updatedAt: now,
    version: u.version + 1,
  }
  return {
    ok: true,
    user,
    events: [{ type: 'UserDeactivated', userId: u.id, occurredAt: now.toISOString() }],
  }
}

// ---------- 投影(对外视图,结构性排除敏感字段) ----------
export interface UserProfileView {
  id: string
  email: string
  nickname: string
  status: User['status']
  verified: boolean
  createdAt: string
}
export function toProfileView(u: User): UserProfileView {
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    status: u.status,
    verified: u.status === 'active',
    createdAt: u.createdAt.toISOString(),
  }
}
```

**域层纪律自查**:以上代码无任何 import;时间由参数注入(可测);错误全部机器可读;`passwordHash` 只进不出(仅 `toProfileView` 对外)。

---

## 6. 端口 `ports.ts`

```ts
// modules/user/ports.ts —— application 依赖的抽象,adapters 实现
import type { Email, PasswordHash, User, UserId } from './domain.js'

export interface TxLike { /* 由 shared/ctx.ts 的 Tx 满足,结构化传入 */ }

export interface UsersRepo {
  insert(tx: TxLike, u: User): Promise<void>                 // 唯一冲突 → USER_EMAIL_TAKEN
  findById(ctx: TxLike, id: UserId): Promise<User | null>
  findByEmail(ctx: TxLike, email: Email): Promise<User | null>
  save(tx: TxLike, u: User): Promise<void>                   // 乐观锁:version 不匹配 → USER_CONFLICT
}

export interface EmailVerificationStore {
  create(tx: TxLike, input: { tokenHash: string; userId: UserId; expiresAt: Date }): Promise<void>
  /** 消费即占用:UPDATE ... SET consumed_at=now() WHERE token_hash=$ AND consumed_at IS NULL AND expires_at>now()
   *  返回 userId;失败(不存在/过期/已用)返回 null。单条 UPDATE 保证原子一次性。 */
  consume(ctx: TxLike, tokenHash: string): Promise<UserId | null>
}

export interface PasswordHasher {
  hash(plain: string): Promise<PasswordHash>                 // argon2id
  verify(hash: PasswordHash, plain: string): Promise<boolean>
  dummyVerify(): Promise<boolean>                            // 用户不存在时消耗同样时长,防枚举
}

export interface AccessTokenIssuer {
  signAccess(claims: { sub: string }): Promise<string>       // JWT,15m
  verifyAccess(token: string): Promise<{ sub: string; exp: number } | null>
}

export interface RefreshStore {
  /** 建立新 family(一次登录一个 family),返回明文 refresh token(只此一次可见) */
  issue(ctx: TxLike, userId: UserId): Promise<string>
  /** 轮换:旧 token 换新;检测到已轮换/已吊销 token 被重放 → 吊销整个 family 并返回 'replayed' */
  rotate(ctx: TxLike, token: string): Promise<
    { ok: true; token: string; userId: string } | { ok: false; reason: 'invalid' | 'expired' | 'replayed' }>
  revokeFamily(ctx: TxLike, token: string): Promise<void>
  revokeAllForUser(ctx: TxLike, userId: UserId): Promise<void>  // 改密/注销全端下线
}

export interface RateLimiter {
  /** true=放行(计数+1);双维度:IP 每分钟 10 次,email 每小时 20 次 */
  allow(ctx: TxLike, ip: string, email: string): Promise<boolean>
}

export interface Mailer {
  sendVerification(to: string, verifyUrl: string): Promise<void>   // 失败只重试,不回滚业务
  sendWelcome(to: string, nickname: string): Promise<void>
}

export interface Outbox {
  enqueue(tx: TxLike, evt: { type: string } & Record<string, unknown>): Promise<void>
}

export interface Clock { now(): Date }
export interface IdGen { next(): UserId }
export interface TokenGen { generate(): { token: string; tokenHash: string } }  // 256-bit + sha256
```

---

## 7. 应用层 `service.ts`(完整 usecase)

> 纪律:一个用例一个函数;所有依赖经 `createUserService(deps)` 闭包绑定一次;
> HTTP 概念(req/res/status)零出现 —— 同一批函数被 api 与 worker 复用。

```ts
// modules/user/service.ts
import {
  authenticate, changePassword, checkPasswordPolicy, deactivate,
  parseEmail, register, toProfileView, updateNickname, verifyEmail,
} from './domain.js'
import type { Email, User, UserId } from './domain.js'
import type * as P from './ports.js'

export interface ServiceDeps extends
  Pick<P, 'UsersRepo' | 'EmailVerificationStore' | 'PasswordHasher' | 'AccessTokenIssuer'
    | 'RefreshStore' | 'RateLimiter' | 'Mailer' | 'Outbox' | 'Clock' | 'IdGen' | 'TokenGen'> {}

// withTx 来自 shared/ctx.ts:开启事务,异常自动回滚,tx 作为受事务约束的端口句柄传入
declare function withTx<T>(ctx: P.TxLike, fn: (tx: P.TxLike) => Promise<T>): Promise<T>
type Ctx = P.TxLike
type R<T> = { ok: true; data: T } | { ok: false; error: P.UserErrorLike }

export function createUserService(deps: ServiceDeps) {

  // ---------- 注册:业务表 + 验证 token + outbox,同一事务 ----------
  async function registerUser(ctx: Ctx, cmd: { email: string; password: string; nickname: string }):
    Promise<R<{ userId: string }>> {
    const email = parseEmail(cmd.email)
    if (!email) return { ok: false, error: { code: 'USER_EMAIL_INVALID' } }
    const policyErr = checkPasswordPolicy(cmd.password, email)
    if (policyErr) return { ok: false, error: policyErr }

    const passwordHash = await deps.hasher.hash(cmd.password)   // IO 在事务外:哈希慢,别占连接
    const { user, event } = register({
      id: deps.idGen.next(), email, nickname: cmd.nickname, passwordHash, now: deps.clock.now(),
    })
    const { token, tokenHash } = deps.tokenGen.generate()

    try {
      await withTx(ctx, async tx => {
        await deps.users.insert(tx, user)
        await deps.verifications.create(tx, {
          tokenHash, userId: user.id, expiresAt: new Date(deps.clock.now().getTime() + 24 * 3600_000),
        })
        await deps.outbox.enqueue(tx, { ...event, verifyToken: token })  // token 只经 outbox→邮件,不落 HTTP
      })
      return { ok: true, data: { userId: user.id } }
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: { code: 'USER_EMAIL_TAKEN' } }
      throw e
    }
  }

  // ---------- 邮箱验证(幂等由 token 一次性保证) ----------
  async function verifyUserEmail(ctx: Ctx, cmd: { token: string }): Promise<R<{ userId: string }>> {
    const tokenHash = sha256(cmd.token)
    return withTx(ctx, async tx => {
      const userId = await deps.verifications.consume(tx, tokenHash)
      if (!userId) return { ok: false, error: { code: 'USER_VERIFICATION_TOKEN_INVALID' } }
      const u = await deps.users.findById(tx, userId)
      if (!u) return { ok: false, error: { code: 'USER_NOT_FOUND' } }
      const r = verifyEmail(u, deps.clock.now())
      if (!r.ok) return r
      await deps.users.save(tx, r.user)
      await deps.outbox.enqueue(tx, r.events[0])
      return { ok: true, data: { userId: userId as string } }
    })
  }

  // ---------- 重发验证邮件(限频:pending 用户 60s 一次) ----------
  async function resendVerification(ctx: Ctx, cmd: { email: string }): Promise<R<true>> {
    const email = parseEmail(cmd.email)
    if (!email) return { ok: false, error: { code: 'USER_EMAIL_INVALID' } }
    const u = await deps.users.findByEmail(ctx, email)
    if (!u || u.status !== 'pending') return { ok: true, data: true }  // 防枚举:一律静默成功
    const { token, tokenHash } = deps.tokenGen.generate()
    await withTx(ctx, async tx => {
      await deps.verifications.create(tx, {
        tokenHash, userId: u.id, expiresAt: new Date(deps.clock.now().getTime() + 24 * 3600_000),
      })
      await deps.outbox.enqueue(tx, {
        type: 'UserRegistered', userId: u.id, email: u.email, nickname: u.nickname,
        occurredAt: deps.clock.now().toISOString(), verifyToken: token, isResend: true,
      })
    })
    return { ok: true, data: true }
  }

  // ---------- 登录 ----------
  async function login(ctx: Ctx, cmd: { email: string; password: string; ip: string }):
    Promise<R<{ accessToken: string; refreshToken: string; user: ReturnType<typeof toProfileView> }>> {
    if (!(await deps.limiter.allow(ctx, cmd.ip, cmd.email)))
      return { ok: false, error: { code: 'USER_RATE_LIMITED' } }

    const email = parseEmail(cmd.email)
    if (!email) return { ok: false, error: { code: 'USER_INVALID_CREDENTIALS' } }
    const u = await deps.users.findByEmail(ctx, email)

    // 防枚举:用户不存在也执行一次等价哈希运算
    const passwordOk = u
      ? await deps.hasher.verify(u.passwordHash, cmd.password)
      : (await deps.hasher.dummyVerify(), false)

    if (!u) return { ok: false, error: { code: 'USER_INVALID_CREDENTIALS' } }

    const r = authenticate(u, passwordOk, deps.clock.now())
    if (!r.ok) return r

    // 失败计数/锁定必须持久化(即使最终返回 401)
    if (r.data.outcome === 'bad-credentials') {
      await withTx(ctx, tx => deps.users.save(tx, r.data.user))
      return { ok: false, error: { code: 'USER_INVALID_CREDENTIALS' } }  // 对外统一;细节进日志
    }

    const accessToken = await deps.tokens.signAccess({ sub: r.data.user.id })
    const refreshToken = await deps.refresh.issue(ctx, r.data.user.id)
    await withTx(ctx, tx => deps.users.save(tx, r.data.user))            // lastLoginAt/清零
    return { ok: true, data: { accessToken, refreshToken, user: toProfileView(r.data.user) } }
  }

  // ---------- refresh 轮换 ----------
  async function refreshSession(ctx: Ctx, cmd: { refreshToken: string }):
    Promise<R<{ accessToken: string; refreshToken: string }>> {
    const r = await deps.refresh.rotate(ctx, cmd.refreshToken)
    if (!r.ok) return { ok: false, error: { code: 'USER_TOKEN_INVALID' } }  // 含重放:family 已被吊销
    const u = await deps.users.findById(ctx, r.userId as UserId)
    if (!u || u.status !== 'active') {
      await deps.refresh.revokeFamily(ctx, cmd.refreshToken)
      return { ok: false, error: { code: 'USER_TOKEN_INVALID' } }
    }
    const accessToken = await deps.tokens.signAccess({ sub: u.id })
    return { ok: true, data: { accessToken, refreshToken: r.token } }
  }

  async function logout(ctx: Ctx, cmd: { refreshToken: string }): Promise<R<true>> {
    await deps.refresh.revokeFamily(ctx, cmd.refreshToken)
    return { ok: true, data: true }
  }

  // ---------- 资料(读走缓存旁路) ----------
  async function getProfile(ctx: Ctx, userId: UserId): Promise<R<ReturnType<typeof toProfileView>>> {
    const u = await loadUser(ctx, userId)
    if (!u) return { ok: false, error: { code: 'USER_NOT_FOUND' } }
    return { ok: true, data: toProfileView(u) }
  }

  async function patchProfile(ctx: Ctx, userId: UserId, cmd: { nickname: string }): Promise<R<true>> {
    return withTx(ctx, async tx => {
      const u = await loadUser(tx, userId)
      if (!u) return { ok: false, error: { code: 'USER_NOT_FOUND' } }
      const r = updateNickname(u, cmd.nickname, deps.clock.now())
      if (!r.ok) return r
      await deps.users.save(tx, r.user)
      await cacheInvalidate(userId)                    // 见 §13
      return { ok: true, data: true }
    })
  }

  // ---------- 改密(事件驱动全端失效) ----------
  async function replacePassword(ctx: Ctx, userId: UserId, cmd: { oldPassword: string; newPassword: string }):
    Promise<R<true>> {
    const u = await loadUser(ctx, userId)
    if (!u) return { ok: false, error: { code: 'USER_NOT_FOUND' } }
    const policyErr = checkPasswordPolicy(cmd.newPassword, u.email)
    if (policyErr) return { ok: false, error: policyErr }

    const oldOk = await deps.hasher.verify(u.passwordHash, cmd.oldPassword)
    const newHash = await deps.hasher.hash(cmd.newPassword)
    return withTx(ctx, async tx => {
      const r = changePassword(u, { oldPasswordOk: oldOk, newHash }, deps.clock.now())
      if (!r.ok) return r
      await deps.users.save(tx, r.user)
      await deps.outbox.enqueue(tx, r.events[0])       // worker 收到后 revokeAllForUser
      await cacheInvalidate(userId)
      return { ok: true, data: true }
    })
  }

  // ---------- 注销 ----------
  async function deactivateSelf(ctx: Ctx, userId: UserId): Promise<R<true>> {
    return withTx(ctx, async tx => {
      const u = await loadUser(tx, userId)
      if (!u) return { ok: false, error: { code: 'USER_NOT_FOUND' } }
      const r = deactivate(u, deps.clock.now())
      if (!r.ok) return r
      await deps.users.save(tx, r.user)
      await deps.outbox.enqueue(tx, r.events[0])       // worker:吊销会话 + 30d 后清理
      await cacheInvalidate(userId)
      return { ok: true, data: true }
    })
  }

  // ---------- Worker 事件入口(与 HTTP 共用同一批域函数) ----------
  async function onPasswordChanged(evt: { userId: string }): Promise<void> {
    await deps.refresh.revokeAllForUser(ctxOfWorker(), evt.userId as UserId)
  }
  async function onDeactivated(evt: { userId: string }): Promise<void> {
    await deps.refresh.revokeAllForUser(ctxOfWorker(), evt.userId as UserId)
    // 延迟清理 job:30 天合规窗口后匿名化(BullMQ delayed job,见 §10.4)
  }

  async function loadUser(ctx: Ctx, id: UserId): Promise<User | null> {
    const cached = await cacheGet(id)                  // §13:profile 缓存,防击穿由 singleflight 保证
    if (cached) return cached
    const u = await deps.users.findById(ctx, id)
    if (u) await cacheSet(id, u)
    return u
  }

  return {
    registerUser, verifyUserEmail, resendVerification, login, refreshSession, logout,
    getProfile, patchProfile, replacePassword, deactivateSelf, onPasswordChanged, onDeactivated,
  }
}

// --- 依赖的 shared helper(签名示意,实现在 shared/) ---
declare function sha256(s: string): string
declare function isUniqueViolation(e: unknown): boolean
declare function cacheGet(id: UserId): Promise<User | null>
declare function cacheSet(id: UserId, u: User): Promise<void>
declare function cacheInvalidate(id: UserId): Promise<void>
declare function ctxOfWorker(): Ctx
```

**应用层自查**:每个用例一个事务边界(`withTx` 只在此层出现);哈希等重 IO 放事务外;所有错误机器可读;`verifyToken` 明文只进 outbox 不进 HTTP 响应。

---

## 8. 基础设施适配器

### 8.1 `adapters/pg-users.ts`(投影白名单 + 乐观锁)

```ts
// 投影结构性排除 passwordHash 之外的全部敏感面;行 → 域模型的映射收敛在一个函数
const USER_COLUMNS = { id, email, passwordHash, nickname, status, failedAttempts,
  lockedUntil, verifiedAt, lastLoginAt, deactivatedAt, version, createdAt, updatedAt }

async function save(tx: Tx, u: User): Promise<void> {
  const rows = await tx.execute(sql`
    UPDATE users SET email=…, password_hash=…, nickname=…, status=…, failed_attempts=…,
      locked_until=…, verified_at=…, last_login_at=…, deactivated_at=…,
      version=version+1, updated_at=now()
    WHERE id=${u.id} AND version=${u.version}`)        // 乐观锁
  if (rows.count === 0) throw new ConflictError({ code: 'USER_CONFLICT' })
}
// insert 捕获 PG 23505 → 抛 USER_EMAIL_TAKEN;findById/findByEmail 使用同列投影
```

### 8.2 `adapters/argon2-hasher.ts`

```ts
// OWASP 2024 推荐:argon2id, 19 MiB, t=2, p=1
hash: (plain) => argon2.hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 })
verify: (hash, plain) => argon2.verify(hash, plain)
dummyVerify: () => argon2.verify(DUMMY_PHC_STRING, randomString())   // 恒定耗时占位
```

### 8.3 `adapters/jose-tokens.ts`(access JWT)

- 算法:EdDSA(Ed25519,`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`);单实例退化用 HS256(`JWT_SECRET`)。
- claims:`{ sub, iat, exp: iat + 900s, iss, aud }`;校验 alg 白名单,拒绝 `none`。

### 8.4 `adapters/redis-refresh.ts`(family 轮换 + 重放检测)

```
key 布局(Redis):
  refresh:{sha256(token)}          → { userId, family }   TTL 30d   当前有效 token(单次有效)
  refresh-used:{sha256(token)}     → { userId, family }   TTL 30d   已轮换墓碑(重放检测)
  refresh-family:{family}          → SET[tokenHash…]      TTL 30d   family 成员索引(吊销用)

issue:  生成 token+familyId → SET refresh:{h} {userId,family} EX 30d → SADD refresh-family:{f} h
rotate: GETDEL refresh:{h}
          命中   → 写墓碑 refresh-used:{h} → 签发新 token(同 family)→ 返回新 token
          未命中 → EXISTS refresh-used:{h}?
                    是 → 重放攻击:SINTER refresh-family:{f} 逐一 DEL+墓碑,返回 'replayed'
                    否 → 'invalid'/'expired'
revokeAllForUser: SCAN user-sessions:{userId} 索引下的所有 family 并逐一吊销
```

> 该模型满足:token 单次有效、被盗重放可检测(整 family 失效)、改密/注销全端下线。
> 明文 token 只在签发响应中出现一次;库内只存 sha256。

### 8.5 `adapters/redis-limiter.ts`

固定窗口(升级位:滑窗 ZSET):`INCR rl:login:ip:{ip}` / `rl:login:em:{sha256(email)}`,`EXPIRE 60/3600`,超阈值拒绝。

### 8.6 `adapters/smtp-mailer.ts`

- 模板渲染与 SMTP 发送;失败抛错 → BullMQ 重试(指数退避,最多 5 次)→ 死信队列告警。
- 发信幂等不依赖 mailer,由 worker 的 `processed_events` 保证(§10.2)。

---

## 9. HTTP 接口层(Hono)

### 9.1 路由契约

| 方法 | 路径 | 鉴权 | 请求 | 成功 | 主要错误 |
|---|---|---|---|---|---|
| POST | `/v1/users` | - | `{ email, password, nickname }` | 202 `{ userId }` | 409 USER_EMAIL_TAKEN;400 校验 |
| POST | `/v1/users/verify-email` | - | `{ token }` | 204 | 400 USER_VERIFICATION_TOKEN_INVALID |
| POST | `/v1/users/resend-verification` | - | `{ email }` | 202(恒成功) | - |
| POST | `/v1/auth/login` | - | `{ email, password }` | 200 `{ accessToken, refreshToken, user }` | 401;429 |
| POST | `/v1/auth/refresh` | - | `{ refreshToken }` | 200 `{ accessToken, refreshToken }` | 401 |
| POST | `/v1/auth/logout` | Bearer | `{ refreshToken }` | 204 | - |
| GET | `/v1/me` | Bearer | - | 200 profile | 401 |
| PATCH | `/v1/me` | Bearer | `{ nickname }` | 204 | 400;409 |
| POST | `/v1/me/password` | Bearer | `{ oldPassword, newPassword }` | 204 | 401;400 |
| DELETE | `/v1/me` | Bearer | - | 204 | - |

### 9.2 zod Schema(入口校验,与域策略分层:格式在此,策略在域)

```ts
const RegisterBody = z.object({
  email: z.string().max(254),                       // 格式最终由域内 parseEmail 裁决
  password: z.string().min(10).max(128),
  nickname: z.string().min(1).max(32),
})
```

### 9.3 路由实现(薄:解析 → 调用 → 映射)

```ts
// apps/api/http/routes/user.ts
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'

export function userRoutes(svc: UserService) {
  return new Hono<{ Variables: { ctx: Ctx } }>()
    .post('/v1/users', zValidator('json', RegisterBody), async c => {
      const cmd = c.req.valid('json')
      const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
      const r = await svc.registerUser(c.var.ctx, { ...cmd, ip })
      return r.ok ? c.json({ userId: r.data.userId }, 201) : c.json(errorBody(r.error), httpStatus(r.error))
    })
    .post('/v1/auth/login', zValidator('json', LoginBody), async c => { /* 同构,略 */ })
  // …其余路由同一形状;不出现任何 SQL/业务分支
}
```

### 9.4 鉴权中间件 + 错误映射(唯一映射点)

```ts
// auth-middleware.ts:Bearer → verifyAccess → c.set('auth', claims);失败抛 USER_TOKEN_INVALID
// error-mapper.ts:onError 里做 code → status 的唯一映射(全表见 §12);zod 失败 → 400 USER_VALIDATION
```

### 9.5 类型出口(RPC 模式)

```ts
export type AppType = ReturnType<typeof buildApp>   // 前端 hc<AppType>() 获得端到端类型
```

---

## 10. 事件与 Worker

### 10.1 事件契约(`modules/user/events.ts`,他域只准 import 这个文件)

```ts
export type UserEvent =
  | { type: 'UserRegistered'; userId: string; email: string; nickname: string; occurredAt: string; isResend?: boolean }
  | { type: 'UserEmailVerified'; userId: string; occurredAt: string }
  | { type: 'UserPasswordChanged'; userId: string; occurredAt: string }
  | { type: 'UserDeactivated'; userId: string; occurredAt: string }
```

> 注:`verifyToken` 仅是 outbox payload 的内部字段,不属于对外事件契约;mailer 在 worker 内读取。

### 10.2 投递链路

```
usecase 事务 ─→ outbox 表(published_at IS NULL)
relay(200ms 轮询 / LISTEN-NOTIFY 唤醒)─→ BullMQ queue 'events' ─→ 标记 published_at
worker ─→ processed_events 幂等闸门 ─→ handler ─→ ack
                                     └→ 失败:指数退避重试 5 次 → 死信 'events-dlq' + 告警
```

### 10.3 幂等闸门(所有 handler 必经)

```ts
async function once(ctx: Ctx, eventId: string, handle: () => Promise<void>) {
  const inserted = await ctx.db`INSERT INTO processed_events (event_id) VALUES (${eventId})
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id`
  if (inserted.length === 0) return            // 已处理,直接 ack(至少一次投递下的必然重复)
  await handle()
}
```

### 10.4 handlers(`apps/worker/handlers/user-events.ts`)

```ts
export async function handleUserEvent(ctx: Ctx, evt: UserEvent, eventId: string) {
  await once(ctx, eventId, async () => {
    switch (evt.type) {
      case 'UserRegistered':
        await mailer.sendVerification(evt.email, verifyUrl(evt))    // evt 内含 verifyToken
        break
      case 'UserEmailVerified':
        await mailer.sendWelcome(evt.email, /* … */)                // 下游(积分/引导)同构订阅
        break
      case 'UserPasswordChanged':
        await userSvc.onPasswordChanged(evt)                        // revokeAllForUser
        break
      case 'UserDeactivated':
        await userSvc.onDeactivated(evt)                            // 吊销 + 投 30d 延迟清理 job
        break
    }
  })
}
```

---

## 11. 安全设计汇总

| 项 | 决策 | 理由/参数 |
|---|---|---|
| 密码哈希 | argon2id,19 MiB / t=2 / p=1 | OWASP 2024;PHC 字符串自带参数可升级 |
| access token | JWT EdDSA,15 分钟 | 无状态验签;吊销语义交给短 TTL |
| refresh token | opaque 256-bit,仅存 sha256,30 天,单次有效 + family 轮换 | 可吊销、可重放检测 |
| 用户枚举防护 | 登录/重发验证对外恒定响应 + dummy verify 等耗时 | 注册场景不防护(邮箱占用需显式告知) |
| 登录限流 | IP 10/min + email 20/h(Redis) | 429 + Retry-After |
| 账户锁定 | 域内策略:5 次失败锁 15 分钟 | 对外仍 401 统一错误,锁定事实进日志/指标 |
| 验证 token | 256-bit,存 sha256,24h,单次消费 | 明文只经邮件链路 |
| 敏感字段 | passwordHash 投影白名单外;日志禁记明文密码/token | 结构性保证,不靠自觉 |
| 传输 | 全链路 TLS;cookie 不用(纯 Bearer/API 场景) | 前端 SSR 场景可换 HttpOnly cookie,另议 |

---

## 12. 错误码目录(code → HTTP 映射,唯一事实源:error-mapper)

| code | HTTP | 场景 | 对外暴露细节 |
|---|---|---|---|
| USER_VALIDATION | 400 | zod 入参校验失败 | 字段级错误列表 |
| USER_EMAIL_INVALID | 400 | 邮箱格式(域裁决) | 无 |
| USER_PASSWORD_POLICY | 400 | 密码策略不满足 | 策略说明文案 |
| USER_VERIFICATION_TOKEN_INVALID | 400 | token 不存在/过期/已用 | 无 |
| USER_INVALID_CREDENTIALS | 401 | 登录失败 / 旧密错误(统一) | 无(防枚举) |
| USER_TOKEN_INVALID | 401 | access/refresh 无效、过期、重放 | 无 |
| USER_NOT_FOUND | 404 | 资源不存在(仅限已鉴权后) | 无 |
| USER_EMAIL_TAKEN | 409 | 注册邮箱占用 | 无 |
| USER_ALREADY_VERIFIED | 409 | 重复验证(同步路径) | 无 |
| USER_CONFLICT | 409 | 乐观锁冲突,客户端重读重试 | 无 |
| USER_RATE_LIMITED | 429 | 登录限流 | Retry-After |
| USER_LOCKED | (日志/指标专用) | 锁定不对外区分 | — |

> Tillgate 落地时按 AGENTS.md 约定接入 `defineErrorCatalog`(英文 `message` + 中文 `zh`,动态事实放 `context`)。

---

## 13. Redis key 规范与缓存策略

| key | 类型 | TTL | 用途 |
|---|---|---|---|
| `refresh:{h}` / `refresh-used:{h}` / `refresh-family:{f}` | string/set | 30d | §8.4 会话族 |
| `rl:login:ip:{ip}` / `rl:login:em:{h}` | string | 60s / 3600s | 登录限流 |
| `cache:user:{id}` | string(json) | 60s | profile 读缓存(旁路):写后失效 |
| `singleflight:user:{id}` | string | 2s | 缓存重建并发合并(防击穿) |

原则:PG 是唯一事实源;缓存只服务 `GET /v1/me` 与 worker 读放大场景;任何写路径先库后删缓存(不双写)。

---

## 14. 配置项(apps/api/config.ts,zod 解析,启动即校验)

```ts
export const Config = z.object({
  databaseUrl: z.url(),
  redisUrl: z.url(),
  jwtPrivateKey: z.string().optional(),       // EdDSA PEM;缺省则要求 jwtSecret
  jwtSecret: z.string().min(32).optional(),
  accessTokenTtlSec: z.number().int().default(900),
  refreshTokenTtlSec: z.number().int().default(2_592_000),   // 30d
  emailVerifyTtlHr: z.number().int().default(24),
  webBaseUrl: z.url(),                        // 拼验证链接
  smtpUrl: z.string(),
})
// .env.example 同步维护;新增键必须更新消费方、配置测试与 .env.example
```

---

## 15. 可观测性

- **日志**(pino,JSON):每请求/每事件带 `requestId`/`eventId`;登录记录 `{ userId, outcome: ok|bad|locked|missing }`(不记明文密码/token);错误带 `err.code`。
- **指标**:`user_registrations_total`、`user_logins_total{outcome}`、`user_tokens_refreshed_total{result}`、`user_refresh_replay_total`、`user_outbox_lag_seconds`(relay 位点延迟)、`user_verification_conversions`。
- **追踪**:HTTP span → usecase span → tx span;worker 侧 `consumer` span 携带 `eventId`,与 outbox 写入 span 串联。
- **告警线**:outbox lag > 60s;死信队列非空;`user_refresh_replay_total` 突增。

---

## 16. 测试计划

### 16.1 域层(表驱动,零 mock,毫秒级)

| 函数 | 必测分支 |
|---|---|
| `checkPasswordPolicy` | 长度边界 9/10/128/129;单字符类;与邮箱相同 |
| `register` | 产出 pending + 事件字段完整 |
| `verifyEmail` | pending→active;active→ALREADY_VERIFIED;deactivated 拒绝 |
| `authenticate` | 成功清零+lastLoginAt;失败计数 4→5 触发锁定且计数重置;锁定期内直接 LOCKED;deactivated 拒绝 |
| `changePassword` | 旧密错;成功换哈希+version+1+事件 |
| `deactivate` / `updateNickname` | 状态拒绝;边界长度 |

### 16.2 应用层集成(Testcontainers:真 PG + 真 Redis)

- 注册:成功落三表(users/email_verifications/outbox 同事务,人为中断验证回滚)。
- 注册:重复邮箱 → USER_EMAIL_TAKEN。
- 验证:token 一次性(第二次 consume 返回 null);过期拒绝。
- 登录:成功签发双 token;失败计数持久化;第 5 次锁定,15 分钟后(时钟注入)可再试。
- 登录:不存在的邮箱耗时与错误响应与错密一致(防枚举断言)。
- refresh:正常轮换旧 token 立即失效;重放旧 token → family 全吊销。
- 改密:发出 UserPasswordChanged,worker 消费后全部 refresh 失效(at-least-once 重复投递两次,断言幂等)。
- 并发:两个事务同改一用户 → 一方 USER_CONFLICT。

### 16.3 HTTP 层(`app.request()` 免端口)

- 契约:上表 10 条路由的成功/错误形状;zod 失败 → 400 字段错误。
- 鉴权中间件:无/伪/过期 token → 401 USER_TOKEN_INVALID。
- 限流:第 11 次/分钟 → 429 + Retry-After。

### 16.4 架构测试(边界固化)

- `domain.ts` import 数 = 0;
- `application` 不 import hono/drizzle/ioredis;
- `adapters` 不 import `application`;
- 跨模块 import 只命中 `events.ts` / application 导出面。

---

## 17. 实施里程碑(建议 TDD 顺序)

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| M0 | shared kernel(ctx/result/withTx/outbox)+ Testcontainers harness | 事务回滚用例绿 |
| M1 | migration ×3 + `domain.ts` 全量函数 | §16.1 全绿 |
| M2 | pg/argon2/jose/redis adapters + ports 契约测试 | §16.2 前四组绿 |
| M3 | service(register/verify/resend)+ HTTP 路由 + 错误映射 | 契约测试绿 |
| M4 | login/refresh/logout + auth 中间件 + 限流 | §16.2/16.3 对应组绿 |
| M5 | worker:relay + handlers + 幂等 + 延迟清理 | 重复投递幂等断言绿 |
| M6 | 加固:架构测试、指标、告警线、.env.example | 根四门(typecheck/lint/test/build)绿 |

---

## 18. 验收清单

- [ ] 域层零依赖,全部行为可表驱动测试(无 IO、时钟注入)
- [ ] 三表写入同事务:注册/验证/改密/注销任一步失败整体回滚,outbox 无孤儿
- [ ] 明文密码/验证 token/refresh token 不出现在任何日志、响应、缓存
- [ ] 登录四要素:限流、防枚举(响应与耗时)、锁定、统一 401
- [ ] refresh 单次有效;重放检测吊销 family;改密/注销全端下线
- [ ] worker 消费幂等(processed_events);死信可观测
- [ ] 错误码目录与 error-mapper 一一对应,无散落映射
- [ ] 架构测试固化依赖方向;域/应用/适配器边界破坏即红
- [ ] 指标与告警线就位(outbox lag、重放、死信)
- [ ] `.env.example`、配置测试、迁移 SQL 与实现同步

---

## 附录 A:状态与事件时序

```
注册:   [caller] → register ─→ users(pending) ─→ outbox(UserRegistered)
        worker: UserRegistered → email(verifyUrl#token)
验证:   [caller] → verifyEmail ─ consume token(一次性) → users(active) ─→ outbox(UserEmailVerified)
登录:   [caller] → authenticate ─ ok ─→ access(JWT 15m) + refresh(family F1, 30d)
刷新:   client → refresh(old) ─ rotate ─→ 新 refresh(F1') ;旧 token 墓碑化
重放:   attacker → refresh(old) ─ 命中墓碑 ─→ F1 全吊销 → 401
改密:   [caller] → changePassword(tx) ─→ outbox(UserPasswordChanged)
        worker: → revokeAllForUser ─→ 所有 family 失效
注销:   [caller] → deactivate(tx) ─→ outbox(UserDeactivated)
        worker: → 吊销会话 + 投 30d 延迟 job(到期匿名化/硬删)
```

## 附录 B:关键决策记录(ADR 简表)

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| 1 | refresh 用 opaque token + Redis,不用 JWT | JWT refresh | 可即时吊销、可重放检测;JWT 无法单点失效 |
| 2 | 验证/发信走 outbox 事件,不在请求内同步发 | 同步 SMTP | 发信失败不应回滚建号;at-least-once + 幂等闸门 |
| 3 | 锁定计数在域内、对外统一 401 | 423 Locked 响应 | 防探测锁定状态;锁定事实走日志/指标 |
| 4 | 乐观锁 version | SELECT FOR UPDATE | 争用低;避免长事务持锁;冲突显式 USER_CONFLICT |
| 5 | email 用 citext | lower() 索引 | 唯一性由库保证,域内 parseEmail 统一小写 |
| 6 | 哈希/SMTP 等 IO 放事务外 | 全部入事务 | argon2 ~50ms 级,事务内占连接放大百倍 |
| 7 | Worker 复用 service 入口 | Worker 另写逻辑 | 单一事实源;事件反序列化为 Command 后同构调用 |
