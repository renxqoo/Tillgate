# 管理端 RBAC v2 施工图

> 状态：**已核销**（2026-08-24,五阶段全部落地;见 §5 验收清单与 §7 数字申报）。设计基线见同目录 DESIGN.md;反转依据见 docs/adr/0008。

## 1. 现状接缝审计（v1 已核销波次的产物）

| 接缝 | v1 现状 | v2 动作 |
| --- | --- | --- |
| domain/rbac | 5 角色矩阵纯函数（can(role,perm) 查表） | 改为 enforced 注册表（41 码 + 域描述）+ `can(codes, code)` 集合判定；矩阵退役 |
| sessionMiddleware | owner 回查 admins 行注入 role 字符串 | owner 一条 join 带回 `{status, isSuper, codes}` 注入上下文 |
| domainGuard | 装配点按 HTTP 方法分派 domain:read/write | 退役；`guardFactory(session)` 逐端点挂码（26 文件机械改造） |
| admins.role varchar | 5 词表 CHECK | 0082 换 role_id，drop 旧列 |
| sidebar-items.ts | 前端静态树 + permission 过滤 | 退役；layout 消费 /v1/me/menus 动态渲染 |
| 80 格矩阵测试 | 锁代码矩阵 | 退役；改种子完整性 + 词表封闭 + 三层完备性对账 |
| openapi errors | 自动补 401 | guarded 端点自动补 403（生成器规则） |

## 2. 逐模块裁决表

| 模块 | 裁决 | 说明 |
| --- | --- | --- |
| db：permissions/roles/role_permissions 表 + 0082 迁移 + drizzle schema | 新写 | 单表权限树；种子 = 注册表导出的 SQL |
| control-plane domain/rbac | 重写 | ENFORCED_RESOURCES 注册表（树定义+码清单）= 种子与启动对账单一源；can/isSuper 纯函数 |
| control-plane ports+adapters：role-store / permission-store / admin-store.findGrants | 新写 | SQL 只在 adapters；grants 解析 = 会话回查那条 join |
| control-plane application：roles/* permissions/*（一动词一文件） | 新写 | list/create/update/delete + 全量替换授权 + 守卫（内置/挂载/子节点/enforced） |
| admin-api middleware/permission.ts | 重写 | guardFactory + requireCode；domainGuard 删 |
| admin-api 26 路由文件 | 复制+微修（机械） | session → guard(code)，逐端点按 §3 清单挂码 |
| admin-api routes/roles.ts permissions.ts、me menus | 新写 | 审计含授权 diff |
| error-face / openapi / api-client | 复制+微修 | 新端点登记 + 403 自动补 + 重生成 |
| apps/admin：动态 sidebar / 角色管理页 / 权限资源页 / HasPerm / admins 页动态角色 | 新写+微修 | sidebar-items 退役；icon 注册表 |
| e2e/admin/rbac-v2.test.ts | 新写 | 见 §4 |

## 3. 端点→码全量清单（26 文件改造的施工依据 = DESIGN §2 表）

机械规则：GET/HEAD → `域:read`；POST 集合 → `域:create`；PATCH/PUT → `域:update`；
DELETE → `域:delete`；动作端点按 DESIGN §2 原词表。逐文件对照 openapi 端点清单执行，
完备性由 TS 签名（路由依赖只剩 guard 工厂）+ 架构测试（仅 auth/me 可裸 session）双锁。

## 4. 测试计划

- control-plane：注册表封闭性（码唯一/合法域/树结构合法：page 有 path、button 挂 page
  下、group 无码）；种子完整性测试（SQL 种子 ↔ 注册表逐行对账——迁移文件文本解析比对
  或种子 JSON 双源一致性）；roles/permissions 用例族（守卫矩阵表驱动：内置不可删/
  enforced 不可删/有挂载不可删/有子节点不可删/code 冲突 409/grants 全量替换 diff）。
- admin-api：guard 工厂（isSuper 短路/授权放行/无权 403/未知码构建期抛错）；
  session join 注入；roles/permissions 路由契约（含审计 diff 断言）；
  既有 24 路由测试零语义漂移（helpers 的 owner fake 改为 codes 形态后全绿）；
  openapi 封闭表 + 产物重生成。
- e2e（rbac-v2.test.ts）：动态建角色（绑 users:read + funds:adjust）→ 授权管理员登入 →
  读放行/写拒绝 → 改绑（加码）即时生效 → 停用权限 kill-switch → 角色停用整组下线 →
  enforced 节点锁（改 code/删除被拒）→ 审计 diff 断言 → 自清理。
- 既有 e2e/admin/journey + rbac.test.ts 回归：种子等价 v1 矩阵 ⇒ 行为零漂移。

## 5. 阶段切片（每阶段独立提交 + 四门全绿）

1. **v2-1 db**：schema + 0082（建表/种子/切换/drop）+ 迁移链测试同步。
2. **v2-2 control-plane**：注册表 + stores + 用例 + facade + 包内测试（含种子对账）。
3. **v2-3 admin-api**：session join + guardFactory + 26 文件挂码 + roles/permissions/
   me-menus 端点 + openapi/错误码 + helpers/既有测试改造。
4. **v2-4 前端**：api-client + 动态 sidebar + 两新页 + HasPerm + i18n + admins 页动态角色。
5. **v2-5 e2e + 收口**：rbac-v2 旅程 + 仓库级四门 + 文档推进「已核销」。

## 6. 验收清单（收口核销用）

- [ ] 0082 落库；既有管理员按旧角色映射 role_id，授权面零漂移（e2e journey/rbac 回归）
- [ ] 41 enforced 码全部有节点、全部有端点挂载、启动对账绿
- [ ] 忘挂码不可编译（TS 签名）；架构测试锁 auth/me 白名单
- [ ] 动态建角色→绑码→登入→放行/拒绝→改绑即时生效→kill-switch 全旅程 e2e 绿
- [ ] enforced 锁与删除守卫逐条断言；custom 仅显隐边界入界面文案
- [ ] sidebar 后端驱动；角色/资源两页可用；HasPerm 全站接入
- [ ] 审计含授权 diff；openapi/api-client 重生成同步
- [ ] 四门全绿；覆盖率达标如实申报；挂账更新（授权乐观锁、grants Redis 缓存）

## 7. 挂账

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 授权编辑乐观锁（expectedRevision 409） | 低频 LWW 够用 | 后续波次 |
| grants Redis 缓存 + 角色版本失效 | 当前单 join 查询无压力 | 后续波次 |
| v1 遗留挂账延续（id 回收 replay 防御等） | 见 docs/admin-rbac/IMPLEMENTATION §6 | 不变 |
