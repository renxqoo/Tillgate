# ADR-0008：管理端 动态 RBAC —— 静态角色裁决反转（动态角色 + 动态注册面）

- 状态：已接受（2026-08-24）
- 关联：docs/admin-rbac/（v1 已核销）、docs/admin-rbac-dynamic/（本波次 DESIGN/IMPLEMENTATION）
- 反转对象：docs/admin-rbac/DESIGN.md §1.2 与裁决 D1（「不做 DB 动态角色」）

## 背景

v1 RBAC（已上线）采用静态模型：5 角色封闭词表 + 权限矩阵单一真相住代码
（control-plane domain/rbac），DB 只存 `admins.role` 字符串。当时理由：改角色能力 =
发版语义，避免权限可被运营编辑引入的审计/迁移复杂度。

上线后需求演进（用户裁决，2026-08-24 讨论定稿）：

1. 角色需要运营期增删改（不发版）；
2. 权限注册面（页面/按钮资源）需要 DB 存储 + CRUD，唯一 `code` 做判定标识；
3. 菜单/页面/按钮三级权限，sidebar 完全后端驱动。

## 决策

反转 D1，采用**动态角色 + 单表权限树**模型，但保留两条 v1 的结构性边界：

1. **判定原语唯一**：`can(code)` 是一切判定（路由/菜单/按钮）的唯一原语；角色绑
   permission（单角色/管理员，绑 id），可见性与接口判定永远同源。
2. **执行面留在代码**：路由→码的映射以**逐端点 `guard(code)` 声明**落在 admin-api
   （方案 B，业界主流形态——Spring @PreAuthorize / RuoYi / Nest Guard 同构），
   TypeScript 签名使「忘挂码 = 编译错误」；**不做 URL ACL 表**（pattern 误配即安全洞，
   发版新增接口忘登记是 fail-closed 事故面）。

enforced（种子落库、语义字段锁死）与 custom（自由 CRUD）两级词表：custom 码真实
作用于角色绑定与菜单门控，但**拆不掉共享端点的接口判定**（显示层隔离 ≠ 安全边界）——
真拆分 = 拆端点 + 新增 enforced 码的小发版。

super_admin 以 `is_super` 隐式全量（不存授权行、不可编辑不可删）——新码自动免疫，
杜绝「改小超管权限锁死全站」的自毁路径。

## 后果

- 迁移 0082 一次切换（零兼容层）：建 permissions/roles/role_permissions，
  5 角色种子（write 展开为动词码，既有授权面零漂移），admins.role → role_id。
- v1 的 80 格矩阵测试退役，改为种子完整性 + 词表封闭性 + 三层完备性对账
  （编译期签名 / 架构测试 / 启动对账 enforced ⊆ DB active）。
- 26 个路由文件机械改造（session → guard(code) 工厂），D5「零侵入」成果就此退役，
  由编译期完备性取代。
- 每请求判定仍为一条 join 查询，角色/授权变更下一请求生效（D2 语义保留）。
