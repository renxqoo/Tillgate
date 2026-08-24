# 管理端 RBAC 施工图（IMPLEMENTATION）

> 状态：**已核销**（2026-08-24，五阶段全部落地；见 §5 验收清单与 §6 数字申报）。
> 设计基线见同目录 DESIGN.md。
> 本功能为**新能力建设**（无旧仓库对应实现），§2 审计对象是 v2 现状接缝而非旧代码。

## 1. 现状审计结论（动代码前的证据）

| 接缝 | 现状 | 审计结论 |
| --- | --- | --- |
| `admins` 表 | 无 role 字段（`packages/db/src/schema/admins.ts`） | 加列迁移，见 DESIGN §3 |
| `sessionMiddleware` | 每请求属主回查 `owner(adminId) → {status}`（`apps/admin-api/src/http/middleware/session.ts:32`） | **可搭载点**：owner 返回结构扩 `role`，回查本就存在，零新增查询 |
| `SessionValidator.owner` 类型 | `Promise<{status} | null>`（结构子集，e2e/装配传 `admins.find` 全量 AdminRecord） | 扩类型为 `{status; role}`，结构子集原则不变 |
| 路由组挂载 | `app.ts:191-278` 每组 `(deps, session)` 二参 | **可搭载点**：装配点组合「session → 域守卫」后原样传入，26 个路由文件零改动 |
| admins 管理面 | **不存在**（无列表/创建/改角色端点；seed 脚本 + `migrate:admin-credentials` 是唯二建管理员途径） | 新增 `/v1/admins` 路由组 |
| identity 建凭据动词 | `credentials.register({userId, identifier, password?})` 存在（`packages/identity/src/identity.ts:101`），幂等（replayed） | 创建管理员正门动词，复用；email 冲突 = `taken` → 409 |
| 前端守卫 | `requireAdmin()`（`apps/admin/src/server/get-admin.ts:22`）仅验会话 | 扩展：me 带 permissions，导航过滤 + 页面兜底 |
| openapi 门禁 | 端点封闭词表 + 产物逐字节比对（`apps/admin-api/__test__/openapi.test.ts`） | 新端点须同步 registry + ENDPOINTS 表 + 重生成产物 |
| 测试替身 | `__test__/helpers.ts` fakeDeps 的 sessions 无 owner | 更新：owner 返回 `{status: 0, role: 'super_admin'}`（与生产装配同形） |

**真 bug 清单**：无（本功能为新能力；审计未发现既有接缝缺陷）。
**契约缺口**：管理端无权限分级（本功能即为补齐项）。

## 2. 逐模块裁决表

| 模块 | 裁决 | 说明 |
| --- | --- | --- |
| `packages/db` schema admins.role + 迁移 0081 | 新写 | 列 + CHECK 词表 |
| `packages/control-plane/src/domain/rbac.ts` | 新写 | 权限模型纯函数（词表/矩阵/can/permissionsOf），单一真相 |
| `packages/control-plane/src/ports/admin-store.ts` | 复制+微修 | AdminRecord 扩 role；新增 list/create/update 动词签名 |
| `packages/control-plane/src/adapters/postgres/admin-store.ts` | 复制+微修 | 投影扩 role；实现三个新动词（SQL 只在此层） |
| `packages/control-plane/src/application/admins/*` | 新写 3 件 | list-admins / create-admin / update-admin（一动词一文件） |
| `packages/control-plane/src/control-plane.ts` | 复制+微修 | admins facade 扩 list/create/update；index 出口 rbac |
| `apps/admin-api` session 中间件 | 复制+微修 | owner 类型扩 role；注入 `adminRole` 上下文变量 |
| `apps/admin-api` permission 中间件 | 新写 | requirePermission + 方法分派域守卫 + 组合器 |
| `apps/admin-api` routes/admins.ts + contracts | 新写 | 列表/创建/改角色 + 审计 |
| `apps/admin-api` routes/me.ts | 复制+微修 | 响应扩 role/permissions |
| `apps/admin-api` app.ts / assembly.ts | 复制+微修 | 各组挂域守卫；identity pick 扩 credentials；挂 admins 组 |
| `apps/admin-api` error-face / openapi registry | 复制+微修 | 三新错误码；新端点登记 + 重生成 |
| `packages/api-client` dto + admin-api client | 复制+微修 | AdminMeInfo 扩字段；listAdmins/createAdmin/updateAdmin |
| `apps/admin` 前端 | 复制+微修 + 新写 | sidebar 过滤/页面守卫微修；/dashboard/admins 页新写 |
| `e2e/admin/rbac.test.ts` | 新写 | 隔离旅程：viewer 403/200 面、admins 管理旅程、自改拒绝 |

## 3. 实施顺序（每阶段独立提交 + 四门全绿）

1. **阶段 1 db**：schema role 列 + 迁移 0081 + `db:migrate` 落库。
2. **阶段 2 control-plane**：domain/rbac.ts + admin-store 动词 + application 三件 + facade 出口 + 包内测试。
3. **阶段 3 admin-api**：session 注入 role + permission 中间件 + 装配点域守卫 + admins 路由组 + me 扩展 + 错误码 + openapi 重生成 + 包内测试（helpers 更新）。
4. **阶段 4 api-client + 前端**：DTO/client 方法 + 导航过滤 + 页面守卫 + admins 管理页 + i18n。
5. **阶段 5 e2e + 收口**：`e2e/admin/rbac.test.ts` 旅程 + 四门 + 文档状态推进。

## 4. 测试计划（铁律 16）

### control-plane（默认门，阈值 90/85 不变）

- `__test__/rbac.test.ts`：
  - **词表封闭性**：domains/actions/roles 三集合穷举断言（全量列出，无多无少）；
  - **矩阵穷举表驱动**：5 角色 × 8 域 × 2 动作 = 80 格逐一断言与 DESIGN §2.4 矩阵一致；
  - `permissionsOf`：全角色返回闭包内权限、无未知权限串；
  - `can`：授权/拒绝/未知角色（fail-closed false）/未知权限串（false）；
  - `assertRole`：非法值抛错（英文 message）。
- `__test__/admins.test.ts` 扩展：create/update/list 用例（内存替身 store）。
- postgres 适配器新动词：`postgres.real.test.ts` 补真实 PG 断言（real 门，不进默认门）。

### admin-api（默认门）

- `__test__/session.test.ts` 扩展：owner 带 role 注入 adminRole；owner 缺失不注入；
  status≠0 仍 401（原语义回归）。
- `__test__/permission.test.ts`（新）：方法分派表驱动（GET/HEAD→read；POST/PUT/PATCH/DELETE→write）；
  授权放行 / 无权限 403 `insufficient_permission` / adminRole 缺失 fail-closed 403 /
  会话无效优先 401（守卫在 session 之后）。
- `__test__/routes-admins.test.ts`（新）：列表形状；创建（store+identity 双动词编排、
  email 冲突 409、角色词表 400）；PATCH（改角色/封禁/自身拒绝 400、displayName 自身可改）；
  审计旁路被调用（action/payload 形状）。
- 既有 24 个路由/装配测试：helpers owner 注入 super_admin 后**必须全绿零改动**（装配形态
  不变的回归证明）。
- openapi：ENDPOINTS 封闭表 + 新端点；产物重生成后逐字节门禁。

### e2e（`e2e/admin/rbac.test.ts`，默认 e2e 门）

装置沿用 `e2e/admin/kit.ts` 全真装配；旅程专属管理员行 `e2e-rbac-*` 前缀就地退役：

1. **viewer 旅程**：插 viewer 管理员行 + 签发真令牌 → GET 目录/用户/观测 200，
   写动词（调账/建渠道/改设置）403，`/v1/admins` 403，`/v1/me` 返回 viewer 权限集；
2. **super_admin 全通**：既有第一管理员（迁移回填 super_admin）→ 上述被拒动词放行；
3. **admins 管理旅程**：POST 创建 operator 管理员（真凭据落库）→ 新管理员凭据可登录
   （authenticate 直调验证）→ PATCH 升 viewer → 其令牌写动词翻转为 403（降权即时生效，
   D2 验证）→ PATCH 自身 role → 400 → 退役（status=2）。
4. 回归：`e2e/admin/journey.test.ts` 零改动全绿（super_admin 回填不变性）。

### 覆盖率申报口径

不调阈值；postgres 适配器仍按 vitest.config.ts 既有排除口径（SQL 行为归 real 门）。
提交时如实报告各包数字。

## 5. 验收清单（收口核销）

- [x] 迁移 0081 落库成功；`admins.role` CHECK 生效；既有行回填 super_admin（psql 实测）
- [x] 词表封闭性 + 80 格矩阵测试绿（control-plane `__test__/rbac.test.ts` 16 用例）
- [x] 既有 24 个 admin-api 路由测试零改动全绿（helpers owner 注入 super_admin 后 155/155）
- [x] viewer/finance/support/operator 拒绝面各有断言（单测表驱动 + e2e viewer 旅程抽样）
- [x] 降权下一请求生效（e2e §G：降权前签发的同一令牌，写动词 200→403 翻转——D2）
- [x] `/v1/me` 带 role/permissions；前端导航按权限过滤；25 个 dashboard 页面 URL 直达兜底
- [x] `/v1/admins` 创建→登录凭据可用→降权→自改拒绝→409 冲突补偿 全旅程 e2e 绿
- [x] openapi 产物重生成 + 封闭表同步（GET/POST/PATCH /v1/admins；api-client DTO 重生成 + 导出快照同步）
- [x] 四门（typecheck/lint/build/test）全绿：仓库级 34/34 任务
- [x] 覆盖率：control-plane 92.69/88.61/93.15/93.64；admin-api 96.6/86.11/90.33/96.98（阈值 90/85，未调）
- [x] journey.test.ts 零改动全绿（super_admin 回填不变性 e2e 回归）
- [x] DESIGN/IMPLEMENTATION 状态推进「已核销」

### 实施期发现与装置适配记录（skill §6.6 口径——每条列名，无静默改断言）

1. **admin id 段分配（D8）**：`apps/admin-api/scripts/create-admin.ts`（2026-08-23 生产裁决）
   ——新管理员 id 必须 ≥1e9（identity_passwords.userId 无 realm 扁平主键）。store.create
   在事务内做 max+1 段分配 + setval；postgres.real.test.ts 断言 `id ≥ 1e9`。
2. **id 回收导致凭据 replay**：e2e 首版补偿用例「删资料行留凭据再重建」实测 201——删行后
   max+1 分配回收同一 id，identifier 判定为 replay（同 userId）而非 taken。装置适配：
   凭据被占场景改为 provisionUser + 为用户注册 email 凭据（真实形态：email 被用户端
   账号占用），断言语义不变（409 + 补偿无孤儿行）。
3. **错误码收敛**：草案的 `admin.email_taken` 落地为 `control_plane.admin_email_taken`
   单码双源（admins 唯一索引 / identity 凭据被占），上下文带 source；404 复用既有
   `admin.admin_not_found`（不造同义双码）。
4. **e2e 运行需 env**：`cd apps/admin-api && bun run test:e2e` 需先 source .env
   （DB_TEST_URL/DATABASE_URL）——kit 探活失败即 world=null 全挂，属装置既有口径。

### 各阶段落地（提交序列）

| 阶段 | 提交 | 四门 |
| --- | --- | --- |
| 1 db | `feat(rbac): admin role column — migration 0081 + design docs` | db 41/41 |
| 2 control-plane | `feat(rbac): control-plane permission model + admin store verbs` | cp 204/204 + real 9/9 |
| 3 admin-api | `feat(rbac): admin-api permission guards + /v1/admins routes + me permissions` | admin-api 155/155 |
| 4 api-client+前端 | `feat(rbac): frontend permission nav + /dashboard/admins page` | admin 132/132 + build |
| 5 e2e+收口 | `feat(rbac): e2e rbac journey + docs closure` | e2e admin 12/12 + 仓库级 34/34 |

## 6. 挂账（不迁/推迟清单）

| 项 | 理由 | 后果 | 归属 |
| --- | --- | --- | --- |
| **管理员 id 回收 + 凭据 replay 防御**（POST /v1/admins 对 `replayed === true` 视同 409 + 补偿） | 现网不可达：管理端无自助注册，唯一删行路径是创建失败的补偿 `remove`（该场景下 id 名下无凭据）；退役只改 status，无 DELETE 端点 | 一旦未来引入**管理员硬删**即触发：删行后 id 段 max+1 分配回收同一 id → 残留凭据判 replay 而非 taken → 201 但指定初始密码被静默丢弃（replay 不写密码）+ 继承旧 TOTP/恢复码/会话锚点。**触发条件：任何硬删管理员的波次必须先落本防御** | 后续波次（触发即升级为必改） |
| ~~`/v1/admins` 分页~~ | **已核销（2026-08-24 修订）**：GET /v1/admins 改统一列表契约（page/page_size/q/sort_by 白名单 + {rows,total,page,pageSize} 信封），store 层 ilike q + count，前端接 ListPage 搜索/分页与统一 RowActions——D7 裁决同步修订 | 无 | 已落地 |
| 动态角色（DB 权限矩阵） | DESIGN §1.2 明确不做 | 需要自定义角色时另开 ADR | 未来 ADR |
| admins 管理操作的通知（新建管理员邮件告知） | SMTP 面已有，但邀请制邮件模板超本功能范围 | 超管需线下传递初始密码 | 后续波次 |
| `migrate:admin-credentials` 脚本对 role 的回填 | 脚本只迁凭据，role 由 0081 默认值覆盖 | 无 | 无 |
