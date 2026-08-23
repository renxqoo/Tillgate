# apps/admin 迁移文档（ai-getway → TokenLens-v2）

> 状态：已完成（代码）——四门全绿 + 覆盖率达标；核销见 §7（运行时完整面依赖
> admin-api P2–P6 后续波，DESIGN §5 矩阵在案）
> 迁移单元：管理后台前端整体（Next.js app 壳 + 27 数据页面 + i18n + BFF 会话编排）
> 旧实现：ai-getway/apps/admin（src 92 文件 / 12,477 行；messages 931×2；无测试）
> 目标位置：apps/admin（结构见 DESIGN §3）
> 关联：DESIGN.md / IMPLEMENTATION.md / 总纲 §3 目标树、§9 P5

## 1. 行为规格基线

v1 无测试——行为等价判定标准为下述可观察行为清单（§7 逐项核销）：

1. URL 路由全部保持（DESIGN §1.1 列举）；`/dashboard` 族全部 force-dynamic。
2. 登录两步流（密码 → 可选邮箱验码 challengeId → token 入 HttpOnly cookie）；错误以
   表单内文案反馈；注销吊销 jti best-effort 后清 cookie 回登录页。
3. 全站守卫：无有效管理员会话 → 重定向 /login（DEV_FAKE_ME=1 dev 后门保留）。
4. 列表页：URL 持有 page/limit/筛选；翻页/筛选可回退可分享；服务端分页信封解析。
5. 变更动作：成功 revalidate 对应路径 + toast；失败表单内/对话框内错误文案（不抛到
   客户端）；金额输入前置正则校验 v1 语义（负号/小数位/零值规则逐页面保持）。
6. i18n：cookie/协商链生效，全部文案 en/zh 双语齐平（词表全量平移）。
7. 主题：首帧 boot 无闪变；侧栏开合状态 cookie 记忆。
8. 语言/主题切换器、账户菜单（登出）在顶栏；侧栏分组与图标 v1 一致。
9. 渠道凭证上传 base64 ≤2MB；兑换码批次明文码仅创建响应一次可见。
10. 链路页：recent 过滤（errorsOnly/service/minDuration/requestId）、瀑布详情、
    requestId 关联、渠道拓扑图（dagre 布局确定性）。

## 2. 审计结论（引用 IMPLEMENTATION §1，不重复）

影响本单元：无真 bug 修复项（B1 记档不改）；越界依赖 3 文件按 §3 裁决清除；
契约缺口 2 项（vendor-catalog 端点、tracing DTO——后者本波补，前者过渡快照）。

## 3. 逐模块裁决表

| v1 文件（相对 apps/admin/src）                    | 行数  | 裁决              | 去处（apps/admin/src）                                                         |
| ------------------------------------------------- | ----- | ----------------- | ------------------------------------------------------------------------------ |
| app/layout.tsx / page.tsx / globals.css           | 55/31 | 复制+微修         | 同位置（fonts/theme-boot 改 app 自持）                                         |
| app/(auth)/layout.tsx / (auth)/login/**           | 225   | 复制+微修         | 同位置；表单组件 → features/auth/                                              |
| app/(main)/layout.tsx                             | 65    | 复制+微修         | 同位置（import 改 v2）                                                         |
| app/api/vouchers/[key]/route.ts                   | 22    | 复制+微修         | 同位置（P5 端点依赖在案）                                                      |
| lib/server-actions/auth.ts                        | 118   | 重写              | server/auth-actions.ts（api-client next session + client）                     |
| lib/server/get-user.ts                            | 34    | 复制+微修         | server/get-admin.ts                                                            |
| navigation/sidebar/sidebar-items.ts               | 102   | 复制              | config/sidebar-items.ts                                                        |
| components/shell/**                               | 163   | 复制+微修         | components/shell/**                                                            |
| i18n/request.ts                                   | 20    | 复制+微修         | config/i18n-request.ts（locale 内核改 api-client/next）                        |
| config/app-config.ts                              | 14    | 复制              | config/app-config.ts                                                           |
| dashboard/page.tsx + _components/admin-charts.tsx | 303   | 复制+微修         | app 页 + features/dashboard/                                                   |
| dashboard/users/**（10 文件）                     | 1344  | 复制+微修         | 页薄壳 + features/users/ + server/users-actions.ts                             |
| dashboard/providers/**（3 文件）                  | 460   | 复制+重写词表源   | features/channels/ + server/channels-actions.ts；ai 词表 → config/protocols.ts |
| dashboard/channels/**（4 文件）                   | 875   | 复制+微修         | features/channels/                                                             |
| dashboard/models/**（4 文件）                     | 1321  | 复制+微修         | features/models/                                                               |
| dashboard/model-market/**（3 文件）               | 773   | 复制+微修         | features/models/（catalog 域）                                                 |
| dashboard/rate-cards/**（4 文件）                 | 589   | 复制+微修         | features/billing/                                                              |
| dashboard/rate-limits/**（3 文件）                | 374   | 复制+微修         | features/channels/                                                             |
| dashboard/plans/**（3 文件）                      | 740   | 复制+微修         | features/billing/                                                              |
| dashboard/subscriptions/**（4 文件）              | 479   | 复制+微修         | features/billing/                                                              |
| dashboard/channel-funds/**（3 文件）              | 585   | 复制+微修         | features/billing/                                                              |
| dashboard/payment-orders/**（3 文件）             | 142   | 复制+微修         | features/billing/                                                              |
| dashboard/redeem-batches/**（5 文件）             | 593   | 复制+微修         | features/billing/                                                              |
| dashboard/billing-operations/**（3 文件）         | 234   | 复制+微修         | features/billing/                                                              |
| dashboard/marketing/**（3 文件）                  | 149   | 复制+微修         | features/billing/                                                              |
| dashboard/referrals/**（3 文件）                  | 222   | 复制+微修         | features/billing/                                                              |
| dashboard/notifications/**（4 文件）              | 282   | 复制+微修         | features/notifications/                                                        |
| dashboard/settings/**（2 文件）                   | 86    | 复制+微修         | features/settings/                                                             |
| dashboard/tracing/**（8 文件）                    | 1084  | 复制+重写 adapter | features/tracing/（graph-adapter → graph-layout 纯函数，DTO 输入）             |
| dashboard/logs/page.tsx + _components             | 278   | 复制+微修         | features/tracing/（ops 读侧域）                                                |
| dashboard/usage-logs/**（2 文件）                 | 330   | 复制+微修         | features/tracing/                                                              |
| dashboard/audit-logs/page.tsx                     | 65    | 复制+微修         | features/tracing/                                                              |
| messages/{en,zh}.json                             | 931×2 | 复制              | messages/（全量）                                                              |
| （v1 ui 包组合件 ×12 + lib ×4）                   | ~1100 | 复制/改写         | components/** + lib/**（IMPLEMENTATION §3 表）                                 |

## 4. API 对照（数据访问）

| v1                                                                          | v2                                                   | 变化理由                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `adminFetch(path, {method, body})`                                          | `adminApi().get/post/patch/delete<T>(path, body?)`   | api-client v2 facade（行为等价在包侧 MIGRATION 在案） |
| `getAdminMe()`（包级）                                                      | `adminApi().getAdminMe()`                            | 同上（B1 会话源裁决后唯一形态）                       |
| `setAdminSessionToken/clearAdminSessionCookie/getAdminSessionToken`（包级） | 同名 `@tokenlens/api-client/next`                    | 子入口纪律（根入口禁 next）                           |
| `@ai-gateway/api-client/i18n`                                               | `@tokenlens/api-client/next` locale 出口             | D1 孪生实现归位                                       |
| `SUPPORTED_PROTOCOLS/vendorProfileNames`（ai 直引）                         | `config/protocols.ts` 快照 → P6 `/v1/vendor-catalog` | P5 清越界 + 词表权威源裁决                            |
| `SpanRow/GraphNode`（tracing 直引）                                         | api-client tracing DTO + `graph-layout.ts`           | 同上                                                  |
| 登录裸 fetch `ADMIN_API_BASE ?? localhost:8082`                             | `getAdminApiBase()`（api-client next）               | 基地址解析收口装配层（铁律 3）                        |

## 5. 测试迁移矩阵

v1 无测试 → 全部为新建（IMPLEMENTATION §7）。删除项：无。

## 6. 回滚方案

本波独立提交（apps/admin 新文件 + api-client DTO 追加 + .env.example 若需）；revert 即
整体还原，不触及其它波次。DDL：无。

## 7. 验收（行为对照核销清单）

- [x] 四门全绿（typecheck 0 / lint 0-0 / 128 用例 / build standalone）+ boundaries 21 workspace
- [x] 架构测试证明零能力包直依赖：workspace import 白名单仅 {ui, api-client}；
      @ai-gateway 引用清零；深导入为零（architecture.test.ts 5 项机器锁定）
- [x] 覆盖率如实申报：lines 97.77 / statements 95.56 / functions 96.39 / branches 88.68
      （阈值 90/85/90/90；口径与 resetModules 规避记录见 IMPLEMENTATION §9）
- [x] admin-api P2–P6 运行时依赖矩阵：DESIGN §5（本文件 §1 十条中受端点未落地影响的是
      运行时数据面，非页面/代码缺失——代码全量迁移，端点落地即通）
- [x] URL 路由 29 条与 v1 一致（sidebar 路由契约测试逐条锁定 page.tsx 存在）
- [x] i18n：en/zh 词表 931 行×2 全量平移；cookie→Accept-Language→默认链经装配测试
- [x] 表单校验语义（金额正则/零值/长度）经表驱动用例锁步（server-actions 套件）
- [x] 链路图投影：与 observability buildTraceGraph 语义锁步向量（trace-graph.test.ts）
- [ ] 登录两步流/守卫/注销的运行时闭环——待 admin-api P2（代码已迁，端点未落地）
- [ ] 渲染回归（RSC 输出/交互）——e2e 波（admin-api P7）覆盖
