# 管理端 RBAC v2 设计基线（动态角色 + 权限树）

> 状态：**定稿**（2026-08-24，讨论四轮收敛；ADR-0008 记录对 v1 D1 的反转）。
> 实施进展见同目录 IMPLEMENTATION.md。v1（静态角色波次）见 docs/admin-rbac/。

## 1. 模型总览

```
admins ──单选──> roles ──多选──> permissions（单表权限树）
role_id            id             parent_id + type(group|page|button)
                   is_super ──┐   code(唯一,group 无码) + path/icon/i18n_key/sort/status
                              │   source(enforced|custom)
判定原语 can(code)：路由 guard / sidebar 可见性 / 按钮显隐 全部收敛于此
```

- **group（目录）**：纯结构无码；可见性 = 子节点授权并集推导。
- **page（页面）**：持 `域:read` 码 + path；管菜单亮显 + 域内全部 GET + 页面守卫。
  详情页（`/users/[id]` 等）不建节点，继承所属 page 的码。
- **button（按钮）**：持动词码，挂 page 之下；管按钮显隐 + 对应写端点。
- **enforced / custom 两级**：enforced = 种子落库（语义字段 code/path/type/父子锁死，
  展示字段 name/icon/sort 可改，不可删不可停用）；custom 全自由 CRUD。
  **custom 拆分共享端点 = 仅显示层隔离**（接口仍查 enforced 码）——入界面文案。
- **super_admin**：`roles.is_super`，隐式全量（无授权行），码集合判定短路；不可编辑
  /删除/停用。其余 4 预置角色 = 种子行：可改可停用（kill-switch：名下管理员下一请求
  起零授权）、不可删（有挂载时删除守卫拦截，DELETE 一律拒绝内置角色）。

## 2. 码规约与全量词表（enforced 清单——IMPLEMENTATION 的种子来源）

规约：`<域>:<动词>`，域词原样（admins/users/funds/catalog/plans/ops/growth/settings）；
标准动词 create/update/delete + 特殊动作原词。**41 个 enforced 码**：

| 域 | read | 写动词（→ 端点） |
| --- | --- | --- |
| users | users:read | users:update（PATCH /users/:id、PATCH /admin-keys/:id）、users:set-password（POST /users/:id/set-password） |
| funds | funds:read | funds:adjust（/channel-funds/adjust、/users/:id/adjust）、funds:recharge、funds:gift、funds:close（/payment-orders/:id/close）、funds:revoke（/redeem-batches/codes/:codeId/revoke）、funds:create（POST /redeem-batches）、funds:retry、funds:abandon |
| catalog | catalog:read | catalog:create（POST providers/channels/models/rate-cards）、catalog:update（PATCH 同上 + PUT/DELETE fx override、PUT fx buffer）、catalog:delete（DELETE 同上）、catalog:restore（providers/channels/models :id/restore）、catalog:test（channels/models :id/test）、catalog:import（POST channels/import、/model-catalog/import）、catalog:refresh（POST /fx/catalog/refresh）、catalog:bind（POST /models/:id/channels） |
| plans | plans:read | plans:create、plans:update、plans:delete、plans:renew、plans:cancel、plans:change、plans:grant（/subscriptions/:id/*） |
| ops | ops:read | （无写端点——ops 域只读） |
| growth | growth:read | growth:create（POST /notifications）、growth:update（PATCH /notifications/:id、PUT /marketing/settings、PATCH /referrals/relations/:id）、growth:delete（DELETE /notifications/:id）、growth:test（/notifications/:id/test） |
| settings | settings:read | settings:update（PUT /settings/billing-timezone） |
| admins | admins:read | admins:create、admins:update、admins:delete（admins/roles/permissions 管理端点共用——本域单受众） |

无码端点：auth 登录族（公开）、logout 与 /v1/me 族（自身域）、探针（公开）。
新增 v2 端点：roles/permissions CRUD → admins 域码；`GET /v1/me/menus` → 自身域无码。

## 3. 执行面：逐端点 guard 声明（方案 B）

- 路由文件依赖签名从 `session: MiddlewareHandler` 改为 `guard: (code: string) =>
  MiddlewareHandler`；每端点注册时声明码。**忘挂码 = 编译错误**（TS 签名即完备性）。
- 仅 auth.ts / me.ts 允许挂裸会话件（公开/自身域）——架构测试锁死。
- 运行时链路：协议栈 → session（验签 + 属主回查一条 join：
  admins⋈roles⋈role_permissions⋈permissions(active)，带回 `{status, isSuper, codes}`）
  → guard(code)（isSuper 短路 / codes 含码放行，否则 403 admin.insufficient_permission）
  → handler。每请求一条 SQL；角色/授权/停用变更下一请求生效（D2 保留）。
- 启动对账：enforced 注册表（control-plane 单一源）⊆ DB active enforced 节点，缺即拒启。

## 4. 数据模型（迁移 0082，一次切换零兼容）

```
permissions: id, parent_id(RESTRICT), type ck(group|page|button), code unique,
  (type='group')=(code IS NULL) ck, name, i18n_key, description, path(page),
  icon(page), sort_order, status ck(0,1), source ck(enforced|custom), ts...
roles: id, code unique, name, description, status, is_super, is_builtin, ts...
role_permissions: (role_id CASCADE, permission_id CASCADE) PK
admins: role_id FK→roles（替换并 drop 旧 role varchar 列）
```

种子（单一流向：代码注册表 → SQL）：
- 权限树 = 现有 sidebar 全结构 + 每页按钮节点（i18n_key 对照前端词表）；
- 5 角色；super 无授权行；operator/finance/support/viewer 按 v1 矩阵展开
  （`域:write` → 该域全部动词码；v1 授权面零漂移。ops:write 无端点，自然蒸发）；
- 既有 admins 行按旧 role 字符串映射 role_id，回填后列置 NOT NULL。
- 撞名规则：custom 码与未来 enforced 种子冲突 → 迁移失败人工改名（绝不静默覆盖）。

## 5. API 面（全部 admins 域码守护；统一列表契约沿用）

- `GET/POST /v1/roles`、`PATCH/DELETE /v1/roles/:id`——PATCH 可改 name/description/
  status/permissions（**全量替换**，LWW）；code/​is_super/is_builtin 不可改；
  删除守卫：内置角色拒删、有挂载管理员拒删、super 拒删。
- `GET /v1/permissions/tree`（全量树，管理面）、`POST/PATCH/DELETE /v1/permissions(/:id)`
  ——custom 节点自由；enforced 节点仅展示字段可改；删除守卫：enforced 拒删、有子节点
  拒删、被角色绑定拒删；path 仅前端管理 UI 校验（前端路由清单白名单）。
- `GET /v1/me/menus`（自身域）——按本人授权过滤的 group+page 两级树，sidebar 数据源。
- `/v1/me` 扩展：`role: {code, name, isSuper}`；`permissions: string[]`（全量已授予码）。
- 审计：role.created/updated/deleted（updated 的 detail 含 **added/removed 码 diff**）、
  permission.created/updated/deleted —— postAudit 旁路。

## 6. 前端

- sidebar 完全后端驱动：layout 调 `/v1/me/menus` → AppSidebar 渲染树（icon 注册表：
  lucide 名→组件，未知名兜底）；`sidebar-items.ts` 退役。
- 按钮显隐：`<HasPerm code="admins:create">`（消费 /v1/me permissions），全站一次性
  接入（执行面后端已全量，UI 显隐为体验层）。
- 新页面（系统管理组）：**角色管理**（列表 + 编辑：码树勾选，勾按钮自动勾页面读——
  纯 UI 便利非不变量）、**权限资源**（树管理 + 码/绑定总览巡检）。
- 管理员页角色下拉改动态（GET /v1/roles）；DEV_FAKE_ME 返回 is_super 形态。

## 7. 已锁定裁决（讨论四轮全量存档）

单角色/管理员；code 不可改名；绑定绑 id、判定用 code；角色绑码不绑节点；停用 =
kill-switch 下一请求生效；共享端点合并 + custom 仅显隐；全站按钮一次盘完；单表权限树；
guard 方案 B；custom 码撞名迁移即败；角色授权 LWW（乐观锁挂账）；i18n 内置 key/
custom 纯文本；详情页无节点；回滚 = 0082 前快照。
