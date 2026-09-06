# 01 · 身份内核（identity 七表）

> 源码：`packages/db/src/schema/identity.ts` · DDL 单一真源：迁移 `0076_identity_tables.sql`（全部语句 `IF NOT EXISTS` 幂等）。
> 业务实现：`packages/identity`（身份能力包）。

## 0. 这个域解决什么问题

「身份」要回答三个互相独立的问题：

1. **谁是谁**——邮箱/手机号/用户名对应哪个账号（标识）；
2. **怎么证明**——密码、OAuth 三方登录、验证码、TOTP、恢复码（凭证）；
3. **登录态怎么作废**——改密码/封号后，已发出去的 token 怎么全部失效（会话吊销）。

Tillgate 把这三件事抽成一个**业务无关的「身份内核」**：七张表不含任何 Tillgate 业务字段（没有余额、没有邮箱营销开关），也不 FK 到 users/admins——`user_id` 由消费方（accounts 包）分配，身份内核只认数字 ID。好处是这套内核可以同时服务两类身份（C 端用户、后台管理员），将来换账号体系时业务表一行不用动。

> 类比：identity 七表像一栋独立的「安保楼」，users/admins 是两栋「业务楼」。安保楼只发工牌号，不关心你在哪栋楼上班。

## 1. identity_credentials — 标识 ↔ 账号（谁是谁）

### 为什么需要它

登录的第一步永远是「拿标识换 userId」：邮箱 `a@b.com` 是哪个账号？这张表就是**标识字典**。一个标识（如邮箱）终身只能属于一个账号——注册/绑定时唯一约束直接拒绝重复。

### 字段明细

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| id | bigserial | PK | 行 ID |
| user_id | bigint | NOT NULL，无 FK | 该标识归属的账号 ID（由 accounts 分配） |
| identifier_kind | varchar(16) | CHECK ∈ {email, phone, username} | 标识类型 |
| identifier_value | varchar(255) | NOT NULL | 标识值（邮箱地址/手机号/用户名原文） |
| created_at / updated_at | timestamptz | 默认 now() | 行时间 |

### 建表 SQL（迁移 0076 原文）

```sql
CREATE TABLE IF NOT EXISTS identity_credentials (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  identifier_kind varchar(16) NOT NULL,
  identifier_value varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_credentials_identifier_uq UNIQUE (identifier_kind, identifier_value),
  CONSTRAINT identity_credentials_kind_ck CHECK (identifier_kind IN ('email', 'phone', 'username'))
);
CREATE INDEX IF NOT EXISTS identity_credentials_user_idx ON identity_credentials (user_id);
```

### 设计要点

- **UNIQUE(kind, value)**：一个邮箱只能映射一个账号，这是防「同邮箱注册两个号」的结构闸。注意不是 UNIQUE(value)——不同类型可以撞名（username=「tom」不妨碍有邮箱含 tom）。
- 正反两个查询都常见，所以 `user_id` 上有普通索引（「这账号绑了哪些标识」）。
- 标识值存**明文**（登录要拿它查表），真正需要保密的是凭证（密码/验证码），见下两张表。

## 2. identity_passwords — 密码（用户知道什么）

### 为什么需要它

密码与标识刻意**分表**：一人一行、按 userId 主键。标识可以换绑多个，密码独立演进（改密/加密算法升级只动这张表）。

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| user_id | bigint | PK | 一人一行，主键即 userId |
| password_hash | varchar(255) | NOT NULL | 密码哈希（不存明文） |
| created_at / updated_at | timestamptz | 默认 now() | 行时间 |

```sql
CREATE TABLE IF NOT EXISTS identity_passwords (
  user_id bigint PRIMARY KEY,
  password_hash varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

设计要点：用 userId 做主键而不是自增 id——「查某人密码」是唯一访问模式，主键即查询键，天然一命中的索引，还从结构上保证一人只有一行密码。

## 3. identity_oauth_links — 三方登录绑定

### 为什么需要它

用户可以用 GitHub/Google 等三方账号登录。绑定关系要防两件事：

- **防劫持**：同一个三方账号（provider+subject）不能绑到两个平台账号——否则攻击者用三方账号「认领」别人的账号；
- **防重复绑定**：同一个平台账号对同一个 provider 只绑一次。

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| id | bigserial | PK | 行 ID |
| user_id | bigint | NOT NULL | 平台账号 ID |
| provider | varchar(32) | NOT NULL | 三方商标识（如 github/google） |
| subject | varchar(255) | NOT NULL | 三方侧的用户唯一 ID（OAuth sub） |
| email | varchar(255) | 可空 | 三方返回的邮箱（展示/提示用） |
| linked_at | timestamptz | 默认 now() | 绑定时间 |

```sql
-- 迁移 0076 原文
CREATE TABLE IF NOT EXISTS identity_oauth_links (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  provider varchar(32) NOT NULL,
  subject varchar(255) NOT NULL,
  email varchar(255),
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_oauth_links_provider_subject_uq UNIQUE (provider, subject),  -- 防劫持
  CONSTRAINT identity_oauth_links_user_provider_uq UNIQUE (user_id, provider)      -- 防重复绑定
);
CREATE INDEX IF NOT EXISTS identity_oauth_links_user_idx ON identity_oauth_links (user_id);
```

注意与 users 表的关系：users 也有 (issuer, subject) 唯一键（见 02 分册）——users 那对是「**创建账号时**的 OIDC 身份」，本表是「**事后绑定**的三方身份」，职责不同。

## 4. identity_challenges — 统一挑战（验证码/一次性码）

### 为什么需要它

「发验证码」场景很多：登录码、注册邮箱验证、找回密码……与其每种各建一张表，不如统一成「挑战」模型：**发一个短码 → 限时 → 限次 → 校验 → 单次消费**。这是七表里约束最精巧的一张，值得逐条读。

### 字段明细

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| id | uuid | PK | 挑战 ID（会进邮件链接/URL，故用 uuid） |
| kind | varchar(32) | NOT NULL | 业务形态（登录码/注册验证/找回…，词表在 identity 包） |
| identifier_kind | varchar(16) | 可空 | 目标标识类型（发码目标尚未注册时用） |
| identifier_value | varchar(255) | 可空 | 目标标识值 |
| user_id | bigint | 可空 | 目标账号（已注册场景用） |
| code_hash | varchar(64) | NOT NULL | **HMAC-SHA256(pepper, code:challengeId)**——码本身绝不落库 |
| payload | jsonb | 可空 | 业务载荷 + 投递上下文（deliveryIp/deliveryLocale） |
| attempts | integer | NOT NULL，默认 0 | 已试错次数 |
| max_attempts | integer | NOT NULL | 错次上限（随行快照，1~100） |
| issued_at | timestamptz | 默认 now() | 发码时间 |
| expires_at | timestamptz | NOT NULL | 过期时间 |
| consumed_at | timestamptz | 可空 | 消费时间（校验成功即单次作废） |
| aborted_at | timestamptz | 可空 | 作废时间（业务主动废弃） |

### 建表 SQL（迁移 0076 原文）与约束逐条解读

```sql
CREATE TABLE IF NOT EXISTS identity_challenges (
  id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL,
  identifier_kind varchar(16),
  identifier_value varchar(255),
  user_id bigint,
  code_hash varchar(64) NOT NULL,
  payload jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  aborted_at timestamptz,
  CONSTRAINT identity_challenges_target_ck CHECK ((identifier_value IS NULL) <> (user_id IS NULL)),
  CONSTRAINT identity_challenges_target_kind_ck CHECK (identifier_value IS NULL OR identifier_kind IS NOT NULL),
  CONSTRAINT identity_challenges_attempts_ck CHECK (attempts BETWEEN 0 AND max_attempts),
  CONSTRAINT identity_challenges_max_attempts_ck CHECK (max_attempts BETWEEN 1 AND 100),
  CONSTRAINT identity_challenges_expiry_ck CHECK (expires_at > issued_at),
  CONSTRAINT identity_challenges_terminal_ck CHECK (consumed_at IS NULL OR aborted_at IS NULL)
);
-- 同 kind 同目标至多一条「活」挑战（部分唯一索引，发码防刷的结构闸）：
CREATE UNIQUE INDEX IF NOT EXISTS identity_challenges_live_identifier_uq
  ON identity_challenges (kind, identifier_kind, identifier_value)
  WHERE consumed_at IS NULL AND aborted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS identity_challenges_live_user_uq
  ON identity_challenges (kind, user_id)
  WHERE consumed_at IS NULL AND aborted_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_challenges_expires_idx ON identity_challenges (expires_at);
```

逐条解读（全是「结构上消灭坏数据」的示范）：

- **① target_ck（目标 XOR）**：挑战要么发给「一个标识」（注册前，还没有账号），要么发给「一个账号」——`(a IS NULL) <> (b IS NULL)` 保证恰一个非空。不约束会出现「双空」（不知道发给谁）和「双有」（目标歧义）的脏行；
- **② target_kind_ck**：有标识值就必须有标识类型，否则「值」无从解释；
- **③ attempts_ck / max_attempts_ck**：防爆破。attempts 被行内上限钳死（永远 0..max_attempts）；上限随行快照（1~100），改配置不影响已发出的码；
- **④ expiry_ck**：过期必须晚于签发；
- **⑤ terminal_ck**：终态互斥，既消费又作废不可能；
- **⑥ 两个 live 部分唯一索引**：防发码刷屏——对同一目标连续点「发送验证码」，新码必须先作废旧码（应用层做替换语义），否则 INSERT 直接被索引拒绝。

### 为什么 code 存 HMAC 而不是明文/裸哈希

- 明文：库被拖即可用码冒充，不可接受；
- 裸 SHA-256：6 位数字码空间太小（10⁶），拖库后离线穷举秒破；
- **HMAC(pepper, code)**：pepper 是库外密钥（环境注入），拖库者也算不出来。哈希里掺 `challengeId` 保证同码不同挑战哈希不同。长度 64 = hex 编码的 SHA-256。

## 5. identity_totp — 时间一次性密码（MFA 第二因子）

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| user_id | bigint | PK | 一人一行 |
| secret | text | NOT NULL | base32 密钥或 SecretCipher 密文 |
| confirmed_at | timestamptz | 可空 | **NULL = 挂起注册**（enroll 未 confirm）；确认前不参与 MFA |
| last_used_step | bigint | NOT NULL，默认 -1 | 已消费的最大步号（30s 一个步） |
| created_at / updated_at | timestamptz | 默认 now() | 行时间 |

设计要点：

- **两段式注册**：扫码 enroll 后 `confirmed_at` 为 NULL，用户必须输一次正确码 confirm 才算开启——防止扫了码但 APP 没存成功导致锁死自己；
- **单调步进防重放**：TOTP 同一个 30 秒窗口的码只用一次。校验成功时把 `last_used_step` 推到当前步号，之后「同码或旧码」重放会被 CAS 拒绝（`last_used_step` 只增不减，默认 -1 表示从未用过）。

```sql
-- 迁移 0076 原文
CREATE TABLE IF NOT EXISTS identity_totp (
  user_id bigint PRIMARY KEY,
  secret text NOT NULL,
  confirmed_at timestamptz,
  last_used_step bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

## 6. identity_recovery_codes — 恢复码

MFA 设备丢了怎么办？开 MFA 时生成一组一次性恢复码。只存哈希（同挑战码思路），用一次作废一个。

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| id | bigserial | PK | 行 ID |
| user_id | bigint | NOT NULL | 归属账号 |
| code_hash | varchar(64) | NOT NULL | 恢复码哈希；UNIQUE(user_id, code_hash) |
| used_at | timestamptz | 可空 | 消费时间（NULL = 未用） |
| created_at | timestamptz | 默认 now() | 生成时间 |

一张用户可以持多行（一组码），每行单次消费。校验即「查 (user_id, hash(code)) 命中且 used_at IS NULL → 原子置 used_at」。

```sql
-- 迁移 0076 原文
CREATE TABLE IF NOT EXISTS identity_recovery_codes (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  code_hash varchar(64) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_recovery_codes_hash_uq UNIQUE (user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS identity_recovery_codes_user_idx ON identity_recovery_codes (user_id);
```

## 7. identity_session_anchors — 会话吊销锚点

### 为什么需要它

平台用无状态 JWT 做会话——签发后服务端不存。但「改密码 / 封号 / 主动登出 everywhere」要求**立刻作废所有旧 token**。锚点的做法：每个会话 token 里带签发时间，校验时对照锚点 `invalid_before`——**早于锚点的 token 一律拒绝**。推高锚点 = 一键吊销全部历史会话。

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| realm | varchar(32) | PK 之一，默认 'user'，CHECK 正则 `^[a-z][a-z0-9_-]{1,31}$` | 身份域：'user' / 'admin' |
| user_id | bigint | PK 之一 | 账号 ID |
| invalid_before | timestamptz | NOT NULL | 此刻之前的 token 全部失效 |
| updated_at | timestamptz | 默认 now() | 最近推进时间 |

设计要点：

- **复合主键 (realm, user_id)**：C 端用户和后台管理员都用自增数字 ID，id=42 可能既是 users#42 又是 admins#42。realm 把两个命名空间隔开，**同号不串号**。
- 推进语义是 `GREATEST(current, new)` 单调向前——并发改密只取最新时刻，永不回退。
- 每个身份一行（不是每个会话一行）：锚点是「水位线」不是「会话清单」，存储 O(身份数) 而不是 O(会话数)。

```sql
-- 迁移 0076 原文
CREATE TABLE IF NOT EXISTS identity_session_anchors (
  realm varchar(32) NOT NULL DEFAULT 'user',
  user_id bigint NOT NULL,
  invalid_before timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_session_anchors_realm_ck CHECK (realm ~ '^[a-z][a-z0-9_-]{1,31}$'),
  PRIMARY KEY (realm, user_id)
);
```

## 8. 七表关系图

七表之间**互不外键**，唯一公共列是 `user_id`（+ realm），全部由 `packages/identity` 的应用层编排：

| 表 | 与 user_id 的关系 | 行数语义 |
|---|---|---|
| identity_credentials | 一账号可挂多个标识 | 一标识一行 |
| identity_passwords | 一人一行 | PK 即 user_id |
| identity_oauth_links | 一账号多三方 | (provider,subject) 与 (user,provider) 双唯一 |
| identity_challenges | 目标二选一（标识 XOR 账号） | 同目标至多一条活挑战 |
| identity_totp | 一人一行 | PK 即 user_id |
| identity_recovery_codes | 一账号一组多行 | 单次消费 |
| identity_session_anchors | (realm,user_id) 一行 | 水位线单调推进 |

消费关系见 [02-accounts.md](./02-accounts.md)：users（OIDC 创建/本地注册）与 admins（email+scrypt，邀请制）。
