# 管理端 RBAC 设计基线（DESIGN）

> 状态：**定稿**（2026-08-24）。实现进展与裁决落档见同目录 IMPLEMENTATION.md。
> 铁律 13 跨包功能（db / control-plane / admin-api / api-client / admin 前端）两件套之一。

## 1. 问题域

### 1.1 处理什么

管理端目前是**单一管理员层级**：`admins` 表无角色字段，`sessionMiddleware`
只要求「有效管理员会话 + 属主回查 status=0」——任何管理员可执行全部后台操作
（资金调账、渠道配置、封禁用户……）。本功能引入**基于角色的访问控制（RBAC）**：

1. 每个管理员持有一个**角色**（封闭词表，存 `admins.role`）；
2. 角色 → **权限集**映射是**代码内单一真相**（control-plane domain 纯函数）；
3. admin-api 每个路由组声明所属**权限域**，读/写动词按 HTTP 方法自动分派；
4. 超管可经新 `/v1/admins` 路由组管理管理员（创建/改角色/封禁）；
5. 前端按 `/v1/me` 返回的权限集过滤导航并在页面级兜底。

### 1.2 明确不处理什么

| 不处理 | 归属 |
| --- | --- |
| 自定义角色（DB 存角色/权限表、运行时编辑权限矩阵） | 不做。角色集是平台行为语义，改角色能力 = 发版；DB 只存「该管理员是什么角色」这一事实（单一真相）。若未来需要，另开 ADR |
| 组织域角色（`org_members.role` owner/member） | `packages/accounts` 组织成员体系，与管理端 RBAC 无关，不动 |
| 用户端（client/client-api）权限 | 本功能只覆盖管理面 |
| 字段级/行级权限（数据脱敏、按渠道隔离） | 不做，本功能只到「路由组 × 读/写」粒度 |
| 网关数据面 API key 鉴权 | `apps/gateway` api-key 中间件，不动 |
| 审计 新增动作的读侧展示 | 复用现有 audit-logs 页面，无新读侧 |

## 2. 权限模型（外部契约）

### 2.1 权限域 × 动作

权限标识 = `<domain>:<action>`。

- **domain（8 个，封闭词表）**：`users` / `funds` / `catalog` / `plans` / `ops` / `growth` / `settings` / `admins`
- **action（2 个）**：`read` / `write`

### 2.2 路由组 → 域映射（admin-api 装配点声明）

| 路由组（apps/admin-api/src/http/routes/） | 域 | 说明 |
| --- | --- | --- |
| users.ts、keys.ts | users | 用户资料/密钥管理 |
| users-funds.ts、channel-funds.ts、vouchers.ts、billing-operations.ts、ops-orders.ts | funds | 一切资金动词（调账/充值/凭证/复核/关单） |
| providers.ts、channels.ts、models.ts、rate-cards.ts、fx.ts、catalog.ts | catalog | 目录与渠道路由配置 |
| plans.ts、subscriptions.ts | plans | 订阅计划 |
| redeem.ts | funds | **裁决**：兑换码批次 = 铸造钱包余额，敏感度与 vouchers 同级 → funds（不放 plans/growth） |
| tracing.ts、ops-logs.ts、ops-usage.ts、ops-tasks.ts | ops | 观测面 |
| marketing.ts、referrals.ts、notifications.ts | growth | 增长运营 |
| settings.ts | settings | 系统设置 |
| admins.ts（新增） | admins | 管理员管理（super_admin 专属） |
| auth.ts、me.ts | 无域 | 公开/自身资料——会话即身份，不设域权限 |

### 2.3 方法 → 动作分派

`GET`/`HEAD` → `read`；`POST`/`PUT`/`PATCH`/`DELETE` → `write`。
由装配点的域守卫中间件自动分派，**路由文件零感知**（守卫在 app.ts 挂载处与
session 中间件组合后作为 `session` 参数传入各路由组）。

### 2.4 角色词表与权限矩阵（代码内单一真相）

角色 5 个，封闭词表：`super_admin` / `operator` / `finance` / `support` / `viewer`。

| domain:action | super_admin | operator | finance | support | viewer |
| --- | --- | --- | --- | --- | --- |
| users:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| users:write | ✓ | ✓ | – | ✓ | – |
| funds:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| funds:write | ✓ | – | ✓ | – | – |
| catalog:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| catalog:write | ✓ | ✓ | – | – | – |
| plans:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| plans:write | ✓ | ✓ | – | – | – |
| ops:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| ops:write | ✓ | ✓ | – | – | – |
| growth:read | ✓ | ✓ | ✓ | ✓ | ✓ |
| growth:write | ✓ | ✓ | – | – | – |
| settings:read | ✓ | ✓ | ✓ | – | ✓ |
| settings:write | ✓ | ✓ | – | – | – |
| admins:read | ✓ | – | – | – | – |
| admins:write | ✓ | – | – | – | – |

角色语义：super_admin=平台所有者；operator=运营工程师（目录/订阅/观测/增长 +
用户管理）；finance=财务（资金对账与调账）；support=客服（用户资料与密钥，
只读其余）；viewer=只读观察。

### 2.5 API 契约变更

#### `/v1/me`（扩展，向后兼容加字段）

```json
{
  "id": 1, "email": "...", "displayName": "...",
  "twoFactorEnabled": false, "totpEnabled": false, "lastLoginAt": null,
  "role": "operator",
  "permissions": ["users:read", "users:write", "funds:read", "..."]
}
```

`permissions` 为该角色权限集全量列表（前端导航过滤的单一事实来源）。

#### `/v1/admins`（新增，admins 域）

| 端点 | 动词权限 | 语义 |
| --- | --- | --- |
| `GET /v1/admins` | admins:read | 列表（id/email/displayName/role/status/twoFactorEnabled/lastLoginAt/createdAt） |
| `POST /v1/admins` | admins:write | 创建：`{email, displayName?, password, role}`。admins 行 + identity 凭据（`credentials.register`，email 标识 + 初始密码）同一事务外先后落库；email 冲突 → 409 `email_taken` |
| `PATCH /v1/admins/:id` | admins:write | `{displayName?, role?, status?}`；**不可改自身 role/status**（防自锁——`admin.cannot_modify_self` 400）；写操作留审计 |

#### 错误码新增（admin.* 目录）

| code | category | 语义 |
| --- | --- | --- |
| `insufficient_permission` | forbidden (403) | 会话有效但角色无该权限 |
| `email_taken` | conflict (409) | 创建管理员 email 已占用 |
| `cannot_modify_self` | invalid_input (400) | 修改自身 role/status |

### 2.6 角色事实的读取时机（无 JWT 嵌角色）

**裁决**：role 不进 JWT。`sessionMiddleware` 的属主回查（每请求必经）投影扩出
`role` 并注入请求上下文 → **角色变更/降权下一请求即生效**，无令牌内角色陈旧窗口，
无额外查询成本（回查本就存在）。装配缺省 owner 的纯会话校验形态下 role 缺失 →
权限守卫 fail-closed 403（不静默放行）。

## 3. 数据模型

迁移 `0081_admins_role.sql`：

```sql
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role varchar(32) NOT NULL DEFAULT 'super_admin';
ALTER TABLE admins ADD CONSTRAINT admins_role_ck CHECK (role in
  ('super_admin','operator','finance','support','viewer'));
```

- **DEFAULT 'super_admin' 的理由**：迁移必须让既有单管理员部署零破坏（旧行为 =
  唯一规格：原先全权限，回填后仍全权限）。新建管理员必经 `POST /v1/admins`，
  契约必填 role，不存在「无意间建出超管」路径；
- drizzle schema `admins.role: varchar(32).notNull().default('super_admin')` + 同词表 CHECK。

## 4. 并发与性能预算

- 权限判定 = 纯函数查表（Map 预构建），每请求 O(1)，**零新增 DB/Redis 查询**
  （role 搭属主回查的便车，该查询本就存在）；
- `/v1/admins` 列表为管理面低频端点，不分页（管理员数量级 < 100）；如未来超量，
  挂账另加分页；
- 前端导航过滤在 Server Component 内完成（`buildSidebarItems` 纯函数），无客户端闪烁。

## 5. 前端行为

- `/v1/me` → `requireAdmin()` 返回带 `role`/`permissions`；
- sidebar 每项声明所需权限（如 `/dashboard/users` → `users:read`），无权限即隐藏
  （`/dashboard` 概览与 `/dashboard/admins` 之外所有页均有域归属）；
- 直接访问无权限 URL → 重定向 `/dashboard`（导航已隐藏，URL 兜底）；
- Server Actions 不做前端重复判定——**后端 403 是权威**，页面守卫仅为 UX；
- 新页面 `/dashboard/admins`（admins:read 可见；创建/改角色按钮按 admins:write 显隐）；
- `DEV_FAKE_ME` 旁路返回 `role: 'super_admin'` 全权限（开发形态与生产形态同形）。

## 6. 方向性裁决汇总（用户裁决/默认裁决落档）

| # | 裁决 | 理由 |
| --- | --- | --- |
| D1 | 静态角色词表（5 角色），权限矩阵住代码，不做 DB 动态角色 | 单一真相；角色能力变更 = 发版语义；避免「权限可被编辑」引入的审计/迁移复杂度 |
| D2 | role 不嵌 JWT，搭属主回查便车每请求现读 | 降权即时生效；零额外查询 |
| D3 | 迁移回填 DEFAULT 'super_admin' | 既有部署零破坏（旧行为唯一规格） |
| D4 | redeem 批次归 funds 域 | 铸造余额的敏感度与 vouchers/调账同级 |
| D5 | 读/写按 HTTP 方法自动分派（GET→read，其余→write） | 路由文件零侵入；26 组路由在装配点一处声明 |
| D6 | 不可改自身 role/status（可改自身 displayName） | 防最后一个超管自锁；改 displayName 无权限面影响 |
| D7 | `/v1/admins` 列表不分页 | 管理员数量级 < 100；超量挂账 |
