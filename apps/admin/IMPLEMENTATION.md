# @tokenlens/admin 施工图

> 状态：本波代码已完成，四门全绿（2026-08-23）；api-client package.json/bun.lock
> 因并行波未提交改动挂起（铁律 15，见 §10）
> 设计基线见 [DESIGN.md](./DESIGN.md)；v1 行为规格映射见 [MIGRATION.md](./MIGRATION.md)。
> 施工纪律：本波只创建 `apps/admin/**` + 修改 `packages/api-client/src/dto/admin-api.ts`
> （DTO 补缺）；工作区并行波在途文件（412 个，铁律 15）一律不碰、不入本波提交。

## 0. 与目标树的偏差登记

- 目录 = 目标树 `src/{app,features,server,config}` + 铁律 14 统一的 `__test__/` 平铺
  （admin-api/trace-receiver 先例）；另设 `src/components`（app 壳）与 `src/lib`
  （纯前端工具）——目标树草图未列但属 app 自有装配面，与 client-api `src/adapters`
  增设同口径。
- features 域映射在目标树五域（users/channels/models/billing/tracing）之上增设
  auth/settings/notifications/dashboard 四域（目标树注释为示例性列举，非封闭词表）。

## 1. v1 审计结论（ai-getway/apps/admin，92 文件 / 12,477 行）

逐文件按 §9.1 四条标准审计（正确性/契约符合/实现质量/依赖方向）。要点：

- **无独立测试**：v1 admin 无任何测试（无 test 目录）——行为规格基线=v1 页面行为本身
  （MIGRATION §1），本波新建测试面（§7）。
- **越界依赖（总纲 §2.2 明示，3 文件）**：
  - `tracing/_components/graph-adapter.ts` import `@ai-gateway/tracing/graph`
    （GraphNode 布局类型）+ `SpanRow`——布局计算纯前端，改为本地纯函数 + api-client DTO；
  - `providers/{page,actions}.tsx` import `@ai-gateway/ai` 的 `SUPPORTED_PROTOCOLS` /
    `vendorProfileNames`——协议词表权威源裁决为 admin-api `/v1/vendor-catalog`（P6），
    过渡快照 `src/config/protocols.ts`。
- **B1（行为缺陷，修）**：v1 `(main)/layout.tsx` 守卫经 `getAdminMe()`——若 admin-api
  不可达，静默重定向登录页（与无会话不可区分）。v2 保留该语义（登录页可达性本身即
  健康信号），不视为 bug，记档不改。
- **D#（重复提取）**：v1 已把列表页基座/确认动作/金额展示收进 ui 包；v2 ui 包重组后
  API 面变化（§3 映射表），app 侧组合件按「Next 耦合归 app」纪律落 `src/components`。
- **契约缺口**：协议词表端点（P6）、tracing DTO（api-client 快照缺失）——本波补 DTO；
  端点挂 admin-api 波次。

## 2. 依赖与装配

- 运行时 workspace 依赖仅两个：`@tokenlens/ui`、`@tokenlens/api-client`（架构测试锁定）。
- `transpilePackages: ['@tokenlens/ui', '@tokenlens/api-client']`（development 条件解析
  到 src 的 workspace 包需列入，v1 同款）。
- api-client 消费模式：每请求 `adminApi()`（`src/server/admin-api.ts` 工厂，内部
  `createNextAdminApiClient()`）——不建模块级单例（Next 模块缓存跨请求共享 client
  实例无状态问题，但工厂调用零成本且免测试桩）。
- v1 `adminFetch(path, {method, body})` → v2 `adminApi().get/post/patch/delete<T>(path, body)`
  （路径白名单/错误信封/分页信封语义 v2 core 已行为等价，api-client MIGRATION 在案）。

## 3. UI 组件映射（v1 → v2）

| v1（@ai-gateway/ui）                                                                  | v2 去处                                                                                   | 动作                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| components/ui/*（button/input/dialog/...）                                            | @tokenlens/ui 根出口同名组件（primitives/forms/data 按新目录）                            | 改 import，props 按 v2 API 微调                                           |
| components/{data-table,status-pill,kpi-card,secret-reveal,form-dialog,password-input} | @tokenlens/ui 同名（data/feedback/forms）                                                 | 改 import + API 适配（v2 DataTable 为自有受控实现，列定义 cell 函数同形） |
| components/ui/sonner + toast                                                          | @tokenlens/ui `Toaster` + `toast`（feedback）                                             | 改 import                                                                 |
| components/shell/header/theme-switcher                                                | @tokenlens/ui `ThemeSwitcher`（navigation）                                               | 改 import                                                                 |
| components/action-toast                                                               | **app 复制** `src/components/action-toast.tsx`                                            | Next/toast 耦合，44 行                                                    |
| components/list-page                                                                  | **app 复制改写** `src/components/list-page.tsx`                                           | 列表基座（v2 ui 无对应；按 v2 primitives 重写装配）                       |
| components/list-filter-select                                                         | **app 复制** `src/components/list-filter-select.tsx`                                      |                                                                           |
| components/money-points                                                               | **app 复制** `src/components/money-points.tsx`                                            | （v2 MoneyDisplay 形状不同，页面用量大，平移成本最低）                    |
| components/simple-icon                                                                | **app 复制** `src/components/simple-icon.tsx`                                             | simple-icons 桥                                                           |
| components/confirm-action                                                             | **app 复制** `src/components/confirm-action.tsx`                                          | （v2 ConfirmDialog 形状不同；确认按钮+action 语义 v1 原样）               |
| components/shell/sidebar/nav-main                                                     | **app 复制** `src/components/shell/sidebar/nav-main.tsx`                                  | Next Link/usePathname 耦合                                                |
| components/shell/header/{account-switcher,locale-switcher}                            | **app 复制** `src/components/shell/header/*`                                              | 同上                                                                      |
| lib/utils（cn）                                                                       | @tokenlens/ui `cn` 根出口                                                                 | 改 import                                                                 |
| lib/list-query                                                                        | **app 复制** `src/lib/list-query.ts`                                                      | URL 查询状态 hook（useSearchParams 耦合）                                 |
| lib/money-tone                                                                        | **app 复制** `src/lib/money-tone.ts`                                                      | 展示 tone 计算                                                            |
| lib/auth-url                                                                          | **app 复制** `src/lib/auth-url.ts`                                                        | 登录回跳 URL                                                              |
| lib/fonts/registry + scripts/theme-boot                                               | **app 自持** `src/config/fonts.ts` + `src/config/theme-boot.ts`                           | ui 禁 next/font（纪律）；根布局 Geist 由 app 直挂                         |
| @ai-gateway/api-client/i18n                                                           | @tokenlens/api-client/next `LOCALE_COOKIE/resolveLocale/isLocale/DEFAULT_LOCALE/htmlLang` | 改 import（D1 孪生实现）                                                  |
| @ai-gateway/ai（SUPPORTED_PROTOCOLS/vendorProfileNames）                              | **app 快照** `src/config/protocols.ts`                                                    | P6 `/v1/vendor-catalog` 落地即切（DESIGN §5）                             |
| @ai-gateway/tracing/graph                                                             | **app 纯函数** `src/features/tracing/graph-layout.ts` + api-client tracing DTO            | 清直依赖                                                                  |

## 4. api-client DTO 补缺（本波唯一包侧改动）

`packages/api-client/src/dto/admin-api.ts` 追加（wire 形状以 v2 admin-api
presenters/contracts 为准逐字段核对）：

- tracing 族：`TraceSummaryRow`（recent）、`TraceDetail`（spans 瀑布）、
  `TraceTopology`（渠道拓扑）、`TracingStats`；
- billing-operations：`BillingOperationRow`；
- 其余缺口（marketing/referrals/notifications/vouchers/payment-orders/stats）**不预写**——
  端点未落地无 wire 事实源，对应页面本波用局部类型 + `adminApi().get<Local>` 内联，
  端点落地波次再进快照（禁止双轨：局部类型注释标注波次）。

tracing DTO 形状来源：`apps/admin-api/src/http/contracts/observability.ts` +
`observability` presenter（v2 已实现行为的 wire 投影）。

## 5. 逐模块裁决表（摘要；全表见 MIGRATION §3）

| v1 模块                                             | 裁决      | 要点                                                                                    |
| --------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| app/layouts/page.tsx/globals.css                    | 复制+微修 | fonts/theme-boot app 自持；globals 引 `@tokenlens/ui/styles.css`                        |
| (auth)/login                                        | 复制+微修 | server action 改 v2 client/裸 fetch（ADMIN_API_BASE 经 api-client next 解析）           |
| lib/server-actions/auth.ts + lib/server/get-user.ts | 重写      | `src/server/auth-actions.ts` + `get-admin.ts`；token 生命周期用 api-client next session |
| navigation/sidebar-items.ts                         | 复制      | `src/config/sidebar-items.ts`                                                           |
| components/shell/{app-sidebar,nav-user}             | 复制      | import 改 v2 sidebar 原语                                                               |
| dashboard 页面 ×27                                  | 复制+微修 | actions → `src/server/*-actions.ts`；_components → `src/features/<域>/`；页面薄壳化     |
| api/vouchers/[key]/route.ts                         | 复制+微修 | 裸 fetch admin-api（P5 端点，代理语义不变）                                             |
| messages/{en,zh}.json                               | 复制      | 全量 931 行/语言                                                                        |
| tracing graph 组件 ×6                               | 复制+微修 | graph-adapter 重写为 graph-layout 纯函数（DTO 输入）                                    |

## 6. 协议词表过渡快照（裁决记录）

`src/config/protocols.ts` = v2 `packages/ai` `SUPPORTED_PROTOCOLS` 当前值的只读快照

- vendor 档案名列表。理由：P6（/v1/vendor-catalog）被 ai 包并行波阻塞；providers 表单
  需要词表渲染下拉，后端 zod 校验（control-plane 词表）是最终防线，前端快照失配的后果
  = 提交被 400 拒绝（显式失败）。P6 落地后本文件删除、改经 admin-api 获取。

## 7. 测试计划（新建面）

| 面          | 文件                                                    | 内容                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架构边界    | `__test__/architecture.test.ts`                         | ① workspace import 白名单（仅 ui/api-client）② 无 `@tokenlens/*/src` 深导入 ③ app 页面不 import server actions 之外的服务端模块 ④ 词表快照封闭性（protocols.ts 导出 == 快照表）                                   |
| server 动作 | `__test__/*-actions.test.ts`                            | mock fetch 断言 wire 调用形状/错误信封映射/返回 `{error}` 形状（vitest 环境 node + next/cache 桩）                                                                                                                |
| 纯函数      | `__test__/{list-query,graph-layout,money-tone}.test.ts` | URL 状态往返、dagre 布局确定性（同输入同布局）、tone 边界                                                                                                                                                         |
| config      | `__test__/config.test.ts`                               | protocols 快照与裁决表一致；app-config 形状                                                                                                                                                                       |
| 覆盖率口径  | vitest.config.ts                                        | 阈值 90/85 施于 `src/{server,lib,config,features}/**` 可测切片；`src/app/**`（页面装配/RSC）与 TSX 展示层排除覆盖率分母——页面由 server 动作 + typecheck/build 覆盖，关键交互组件另以 jsdom 渲染测试锁定（§11 起） |

## 8. 施工顺序

1. 脚手架（package.json/tsconfig/next.config/postcss/vitest/globals.css/messages）
2. api-client DTO 补缺 → 包门禁
3. app 壳（layouts/login/guard/sidebar/i18n/fonts/theme-boot）+ 架构测试
4. features 域迁移：users → channels → models → billing 族 → tracing 族 → 其余
5. 测试补齐 → 四门 + boundaries → 文档收口 → 提交（逐文件点名）

## 9. 门禁记录（2026-08-23 复跑回填）

| 门禁       | 命令                                      | 结果                                                                                               |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| typecheck  | `bun x tsc --noEmit`                      | ✅ 0 错                                                                                            |
| lint       | `bun x oxlint`                            | ✅ 0-0（135 文件）                                                                                 |
| test       | `bun x vitest run --coverage`             | ✅ 128/128（12 文件）；lines 95.56 / branches 88.68 / funcs 96.39 / stmts 97.77（阈值 90/85 达标） |
| build      | `bun run build`                           | ✅（/login、/dashboard/users/[id] 等动态路由产物正常）                                             |
| boundaries | `bun scripts/check-package-boundaries.ts` | ✅ 21 workspace 无环、深导入/越界为零                                                              |

## 10. 挂起记录（铁律 15）

- `packages/api-client/package.json` 与 `bun.lock`：本波 DTO 补缺触及 package.json，
  与并行波共写文件混有他人未提交变更——不随本波提交，待工作区整体收口时逐文件点名
  处理（内容本身已过门禁验证，仅提交动作挂起）。

## 11. 计费异常复核弹窗（小级方案）

> 状态：已核销；用户裁决：将无法输入的行操作下拉改为“操作”按钮 + 模态弹窗。

### 11.1 契约与边界

- 复核列表操作列只展示“操作”按钮；点击后弹窗包含复核理由输入框、重试、废弃、关闭。
- 重试/废弃继续调用既有 server action，参数、乐观锁、审计与错误信封均不改变。
- 空白理由不出站并提示；理由上限保持 1000 字符。
- 成功后关闭弹窗并清空理由；失败时保留弹窗和输入，允许修正后重试。
- 提交期间三个动作按钮均禁用，防止重复决策或请求中途卸载。
- 不处理：死单状态机、资金释放和审计事务仍归 billing/admin-api；列表刷新仍归既有
  server action 的 `revalidatePath`。

### 11.2 测试与验收

- [x] 点击“操作”打开弹窗，输入框可获得焦点并输入内容；关闭后再次打开为空。
- [x] 空白理由不调用 action；重试/废弃分别透传 requestId、revision 与已输入理由。
- [x] 成功关闭弹窗；失败保留弹窗、理由和可重试状态；pending 阶段防重复提交。
- [x] 中英文词表同步；159/159 测试通过；覆盖率 statements 93.40%、branches 85.30%、
      functions 92.81%、lines 96.07%；format/typecheck/lint/build 通过。
