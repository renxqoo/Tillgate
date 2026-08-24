# 全字段编辑 + 绑定全字段更新 方案
> 状态：已核销（2026-08-24;提交 86eb0d0 / 6bfac93 / 32a7159 / 本提交）
> 级别：中（PATCH /v1/endpoint-bindings/:id 契约变形 + cp 端口改形 + 前端两页改造）
> 前置：docs/admin-rbac-dynamic/DESIGN.md §8（ADR-0009 执行面数据化）已实施——
> 后端 update/delete permission 已是全字段/全节点（本轮探查确认），缺口集中在前端与绑定编辑面。

## 需求

1. **权限资源**：编辑弹窗放开全字段（现状：enforced 节点看不到状态开关，仅 custom 可改）；
   删除对所有节点开放（有子节点不能删）；状态列用统一 StatusPill。
2. **接口绑定**：支持编辑所有字段（现状：只能换绑 permission，method/path 创建后不可改）；
   删除（解绑）已存在；**权限删除的「先解绑」守卫**（permission_in_use）后端已实现，
   前端补错误文案透出即可。

## 契约

### PATCH /v1/endpoint-bindings/:id（变形）
- body：`{ method?, path?, permissionId? }`——三字段全可选，**至少一项**（空 body 400
  `invalid_endpoint_input`）；method ∈ GET/HEAD/POST/PUT/PATCH/DELETE；path trim 后 2-255。
- 语义：部分更新，仅覆盖提供的字段；`(method, path)` 终态撞既有其他绑定 → 409
  `endpoint_bound`（唯一索引 endpoint_permissions_endpoint_uq 同口径，排除自身）。
- id 不存在 → 404 `endpoint_not_found`；permissionId 不存在 → 404 `permission_not_found`。
- 审计：action `binding.updated`（原 `binding.rebound` 收口单轨改名）。
- 其余端点不变（POST/DELETE/GET 与错误码词表沿用）。

### PATCH /v1/permissions/:id（无变化）
- 已全字段（wave 3 放开）；本轮仅前端补齐传参与控件。

## 问题域

- 处理：权限编辑弹窗全字段（type/parent 联动、码规则提示）；权限删除全节点开放 +
  子节点客户端预检（禁用菜单项 + 提示，后端 permission_has_children 兜底）；状态列
  StatusPill；绑定编辑弹窗三字段；cp `EndpointStore.rebind` 改形为 `update`；
  e2e §L 扩展（编辑 method/path 后 ACL 按新组合判定）。
- 不处理：
  - `source` 字段不进编辑弹窗（enforced/custom 是种子出处事实，改它=伪造出处，
    无运营语义）——默认裁决；
  - 权限删除的绑定守卫逻辑（已实现，本轮只透出文案）；
  - 启动对账/kill-switch 语义（既有行为，不受影响——停用 enforced 码 = 该码对所有
    非超管角色下一请求失效，ADR-0008 语义）。

## 裁决

- 「编辑能修改所有」＝ 除 `source` 外的全部字段（含 code/type/parentId；type 切换时
  父选项与字段显隐联动，后端结构校验兜底）——**默认裁决**。
- 绑定编辑为部分更新语义（只传要改的），非全量替换——**默认裁决**（与 PATCH 语义一致）。
- 其余均沿用既有用户裁决：enforced 全放开、码唯一仅约束按钮、先解绑才能删权限。

## 拆分与实施顺序（每阶段四门 + 独立提交）

- **A. cp 层**：`EndpointStore.rebind → update(db, id, {method?, path?, permissionId?})`
  （port/memory/postgres 单轨改形，删 rebind）；application `rebind-endpoint.ts →
  update-endpoint-binding.ts`（终态重复检查排除自身）；单测改写。
- **B. admin-api**：契约 `endpointContracts.rebind → update`（三可选字段 + refine 至少一项）；
  路由 PATCH 全字段；审计 `binding.updated`；路由/openapi 测试同步。
- **C. api-client + 前端绑定页**：`rebindEndpoint → updateEndpointBinding`；server action
  `rebindAction → updateBindingAction`；RebindDialog → 全字段编辑弹窗（method/path/permission）。
- **D. 权限资源前端**：编辑弹窗全字段 + 删除全节点开放（子节点预检禁用）+ StatusPill；
  i18n 补键（editTitle 全字段文案、按钮禁用提示）；清理无抛出点的
  `permission_immutable` i18n 键（若确认零引用）。
- **E. e2e + 文档收口**：§L 扩展「编辑 method/path → 旧组合 fail-closed、新组合按码判定、
  终态撞他绑 endpoint_bound」；本文档状态 → 已核销。

## 测试口径

- 契约：PATCH 空 body 400；仅 method / 仅 path / 组合 各生效；method 枚举外 400。
- 边界：`(method,path)` 终态撞他绑 → endpoint_bound；撞自身（no-op）放行；
  permissionId 不存在 / id 不存在；改 method+path 后 ACL 判定迁移（e2e）。
- 回归：既有换绑即时生效、解绑 fail-closed、改码零漂移三断言不变绿。

## 验收清单（核销）

- [x] 权限编辑弹窗：全字段可改（含 enforced 状态停用/恢复;type 切换父选项回落联动）
- [x] 权限删除：全节点可发起；有子节点前端禁用（deleteBlockedHint）+后端
  permission_has_children/permission_in_use 文案透出
- [x] 状态列 StatusPill（success/neutral,与 admins 页同口径）
- [x] 绑定编辑：method/path/permission 三字段部分更新;终态撞他绑 409 endpoint_bound;
  ACL 迁移下一请求生效（e2e §M:旧组合 fail-closed、新组合过 ACL）
- [x] 绑定删除（解绑）既有功能不回归（e2e §L 既有断言全绿）
- [x] 四门：typecheck/lint 34/34、build 20/20、test 33/33（@tillgate/ui 在途重构
  5 用例失败,归属并行开发,非本改动）;admin e2e 18/18（rbac-roles 6/6 含新 §M）;
  cp 199/199、admin-api 157/157、admin 131/131、api-client 91/91、db 41/41
