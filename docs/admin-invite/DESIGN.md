# 管理员邀请制创建（邮件设置初始密码）方案

> 状态：已核销
> 级别：中（跨 apps/admin、admin-api、identity、db、api-client；外部契约变形 + 新端点 + 安全语义）

## 契约

### 1. `POST /v1/admins`（变形：删除 password）

- 请求：`{ email, displayName?, roleId }`。**删除 `password` 字段**（零兼容层，不留可选收）。
- 响应 201：`{ ...AdminRow, inviteSent: boolean }`（AdminRow 新增 `hasPassword`，见下）。
- 行为时序（终态最后）：
  1. `control-plane admins.create` 建资料行；
  2. `identity.credentials.register` 仅挂 email 标识（不带密码——`registerCredential` 的 password 本就可选）；
  3. `identifier_taken` → 补偿删资料行 → 409 `control_plane.admin_email_taken`（既有语义保留）；
  4. 尽力投递邀请邮件（SMTP 生效且 `ADMIN_FRONTEND_URL` 已配才尝试）；
  5. 旁路审计 `admin.created`（detail 含 `inviteSent`）。
- 邮件投递失败（SMTP 未生效 / URL 未配 / sendMail 抛错）**不回滚创建**，响应 `inviteSent:false`：
  补偿 remove 只删 `admins` 资料行、不级联 identity 凭据——回滚会留孤儿 identifier，
  死锁同邮箱重建。数据终态（行 + 标识 + 无密码）自洽，列表「重发邀请」可补救。

### 2. `GET /v1/admins`（扩展）

- AdminRow wire 投影新增 `hasPassword: boolean`（来自 `identity_passwords` 是否有行；
  一次 IN 查询防 N+1）。列表消费：待激活标记 + 重发按钮显隐。

### 3. `POST /v1/admins/:id/resend-invite`（新）

- 权限绑定：`admins:update`（0092 先例——绑既有码不新增码；操作对象是既有管理员行）。
- 请求：无 body。响应 200 `{ ok: true }`。
- 前置校验链：
  1. 404 `admin.admin_not_found`（资料行缺失）；
  2. 409 `admin.invite_not_needed`（已设密码——已激活，链接无意义）；
  3. 403 `admin.account_unavailable`（封禁/注销，不给封禁者发激活邮件）；
  4. 429 `admin.invite_rate_limited`（retryAfterMs=60000，Redis `admininvite:cooldown:<id>` 60s 冷却）；
  5. 503 `admin.invite_link_unavailable`（SMTP 未生效或 `ADMIN_FRONTEND_URL` 未配——
     重发是显式动作，哑成功会误导操作员）。
- 通过后：签发新 token（旧 token 不撤回，30min 自然过期 + 消费期校验兜底）→ 发信 →
  标记冷却 → 审计 `admin.invite_resent`。

### 4. `POST /v1/auth/reset-password`（新，公开）

- 加入 ACL `PUBLIC_ROUTES`（与登录族同列，无会话直通）。
- 请求：`{ token: 20..128, password: 1..128 }`（强度策略单源在 identity：minLength 8）。
- 响应 `{ ok: true }`。成功**不自动登录**（对齐 C 端 forgot 交互：跳登录页手动登录）。
- 消费校验链（任一失败统一 400 `admin.reset_token_invalid`，不泄漏具体原因）：
  1. Redis `GETDEL` 一次性消费（重放即无效）；
  2. 资料行存在；
  3. 状态 active（封禁/注销不可激活）；
  4. **目标尚未设密码**——已激活账号的旧邀请链接即使泄露也无法改密码（安全不变量）。
- 通过后 `identity.passwords.reset({ realm: 'admin' })`：策略校验 → scrypt 哈希 →
  事务内落库 + 推进 admin realm 吊销线 + 同事务审计（既有用例，无新事务边界）。
- 弱口令 400 `identity.weak_password`（真实原因可反馈——token 已消费，无枚举面）。

### 5. 邀请令牌存储（Redis）

- `apps/admin-api/src/adapters/redis-admin-invite.ts`（client-api `redis-reset-token` 同构）：
  - 键 `admininvite:token:<sha256(token)>` → adminId，TTL **1800s（30 分钟，用户裁决）**；
  - 32 字节 random base64url 明文仅签发时返回，入库只存哈希；
  - `GETDEL` 原子单次消费；
  - 冷却键 `admininvite:cooldown:<adminId>`（60s，SET NX EX 语义）。
- Redis 不可达：错误自然冒泡 500（与 C 端 reset-token store 同口径，不静默降级）。

### 6. 邮件（identity Mailer port 扩展）

- port 新增 `sendAdminInviteLink(to, url, ctx: { locale?; ttlMinutes })`（不带 ip——
  触发者是管理员操作而非最终用户请求）。
- 新模板 `renderAdminInviteEmail`（双语：「设置管理员初始密码」语义，30 分钟有效、
  一次性链接；复用 login-code-email 的样式基建）。
- 实现：identity 内置 `nodemailer-mailer` 真实现（模板单源）；admin-api 的
  `smtp-admin-mailer` / `dynamic-admin-mailer` 真实现；client-api 两个 mailer 副本补
  「端口合规空实现」（与 admin mailer 现有 `sendPasswordResetLink` 空实现对称）。

### 7. 配置

- admin-api config 新增 `ADMIN_FRONTEND_URL: z.string().url().optional()` →
  `adminFrontendUrl`；拼链接 `${url}/reset-password?token=<encodeURIComponent(token)>`。
- `.env.example` 补键；未配置时创建路径 inviteSent:false、重发路径 503（见上）。

## 问题域

- 处理：创建管理员（无密码 + 邀请邮件）、重发邀请（冷却 + 前置校验）、
  消费邀请设置初始密码、列表 hasPassword 投影。
- 不处理：
  - 已激活管理员的「忘记密码」自助找回（管理端无 forgot 流；挂账，本期不做——
    已激活者用 `/v1/me/password` 改密，真丢密码走 CLI create-admin 幂等路径或 DB 运维）；
  - CLI `create-admin.ts` 直接设密码路径（保留为逃生门，不受影响）；
  - C 端用户忘记密码流（不动）。

## 并发/一致性预算

- token 一次性：Redis GETDEL 原子；并发同 token 只有一个成功。
- 多 token 并存（重发不撤旧）：每 token 独立 TTL 30min；消费期「目标无密码」校验
  保证先激活者生效、其余链接自动作废。
- 冷却 60s：SET NX EX，重发连点只有一个发出。
- 邮件同步发送在请求路径内（对齐 C 端 forgot；管理面 QPS 无感；投递失败不回滚，见契约 1）。
- 无新事务边界：挂标识 / 落密码分别复用 registerCredential / resetPassword 既有事务。

## 拆分

| 层 | 位置 | 内容 |
| --- | --- | --- |
| packages/identity | ports/mailer、templates/admin-invite-email | port 方法 + 双语模板 |
| packages/identity | ports/credential-store、adapters/postgres/passwords、identity.ts | `passwordExists` IN 查询 + facade `passwords.exists` |
| apps/admin-api | http/contracts/admins、http/routes/admins | create 去 password + resend 端点 |
| apps/admin-api | http/routes/auth、middleware/acl | 公开 reset-password 端点 + PUBLIC_ROUTES |
| apps/admin-api | http/error-face | invite_not_needed / invite_rate_limited / invite_link_unavailable / reset_token_invalid |
| apps/admin-api | adapters/redis-admin-invite、adapters/smtp-admin-mailer、adapters/dynamic-admin-mailer | 令牌/冷却 store + 邀请发送 |
| apps/admin-api | config、assembly | ADMIN_FRONTEND_URL + 依赖注入 |
| packages/db | migrations/0093 | `POST /v1/admins/:id/resend-invite` → admins:update 绑定 |
| packages/api-client | dto/admin-api.generated、admin-api.ts | AdminCreateBody 去 password、AdminRow +hasPassword、resendAdminInvite |
| apps/admin | features/admins、(auth)/reset-password、server actions、messages | 表单/菜单/badge/页面/i18n |
| apps/client-api | adapters/smtp-login-mailer、dynamic-login-mailer | port 空实现补齐（类型合规） |

依赖方向不变：packages 不依赖 apps；admin-api 经 identity facade 消费。

## 实施顺序

1. identity 扩展（port/模板/facade 读面/适配器）+ 单测；
2. admin-api（契约/路由/错误码/Redis 适配器/配置/装配）+ migration 0093 + 路由测试；
3. api-client DTO/方法 + client-api mailer 空实现；
4. admin 前端（创建表单/行操作/页面/i18n/actions）；
5. 四门（typecheck/lint/build/test）+ 覆盖率核对 + 收口。

无过渡态：`password` 字段一次删净，前后端同批合入，单轨收口。

## 裁决

- **用户裁决 1**：SMTP 未配置时允许创建但不发邮件（inviteSent:false + 列表重发补救，
  不 fail-closed 创建）。
- **用户裁决 2**：邀请链接有效期 30 分钟（与 C 端找回一致）。
- **用户裁决 3**：重发按钮在管理员已激活（已设密码）后隐藏；封禁/注销管理员同样隐藏；
  60s 冷却内禁用防连点。
- 默认裁决（否决窗口内可改）：
  - resend 权限码绑 `admins:update`（0092 先例：不新增码）；
  - 已激活后旧邀请链接消费期校验作废（防泄露链接改已激活账号密码）；
  - 投递失败不回滚创建（remove 不级联凭据，回滚留孤儿 identifier 死锁同邮箱重建）；
  - 设置密码成功后不自动登录（对齐 C 端交互）；
  - 重发路径 SMTP/URL 未配 503 显式失败（创建路径才是「允许但不发」）。

## 测试口径

- 契约断言：
  - 创建响应无 password 语义、含 inviteSent/hasPassword；email_taken 补偿保留；
  - 邀请邮件 to/url 形态（`${base}/reset-password?token=…`）与 ttlMinutes=30；
  - resend 五态（200/404/409/403/429/503）表驱动；
  - reset 成功终态：`passwords.authenticate` 可通过（业务终态非仅 200）。
- 边界与异常：
  - token 重放、已激活后旧 token、封禁目标、资料行缺失 → 统一 reset_token_invalid；
  - token 长度 <20/>128、password 空/超长 → validation_failed；
  - 弱口令 → identity.weak_password；
  - 创建投递抛错 → 201 + inviteSent:false + 行保留；
  - resend 冷却窗口内二次 → 429 + retryAfterMs。
- 越权矩阵：无 `admins:update` 码调 resend → 403（ACL 面既有基建）；
  reset-password 无需会话（公开）但 token 不可伪造（随机 32B）。
- 回归：routes-admins 既有用例全量保留（创建/更新/自改守卫）。

## 验收清单

- [x] POST /v1/admins 无 password 输入、inviteSent 如实、投递失败不回滚（routes-admins 4 用例）
- [x] GET /v1/admins hasPassword 投影（IN 单查；列表用例断言 exists 单次调用）
- [x] resend-invite 六态（200/404/409/403/503/429）+ 冷却 + 审计 admin.invite_resent
- [x] reset-password 一次性消费 + 已激活作废 + 封禁拒绝 + 终态可鉴别登录
      （单测 5 组 + e2e/admin 旅程全真验证：创建 inviteSent:false → 激活 → 旧链接作废 → hasPassword 投影）
- [x] 重发按钮已激活/封禁隐藏（canResend && !hasPassword && status===0）；待激活标记展示
- [x] ACL：PUBLIC_ROUTES + admins:update 绑定（migration 0093；rbac-matrix S 段零缺失）
- [x] 四门全绿；覆盖率（阈值 lines/stmts/funcs 90、branches 85）：
  identity 94.16/90.74/96.75/95.05，admin-api 96.84/87.55/90.46/97.10，
  admin 93.42/85.64/92.21/95.99，api-client 99.44/96.63/98.46/100，db 98.82/96.66/97.82/99.13
