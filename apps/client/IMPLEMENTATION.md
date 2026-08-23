# apps/client 施工图（IMPLEMENTATION）

> 状态：实施中
> 前置：DESIGN.md（定稿）。本文承接 §9.1 七步流程的步骤 2–6：审计 → 裁决 → 拆分 → 测试计划 → 实施顺序。
> 旧实现：`/Users/wrr/work/ai-getway/apps/client`（63 文件 / 7091 行 / 0 测试）+ 被消费面旧 `packages/{api-client,ui}`。

---

## 1. 审计结论（旧实现全量审计，四条标准）

审计方法：63 文件逐文件读；被消费的两个 workspace 包按「实际 import 符号」回源读签名与行为（完整取证报告两份，2026-08-23）。

### 1.1 真 bug 清单（B#，计 14 条确认 + 6 条定性为取舍/低危）

| # | 症状 | 位置 | 级别 | 处置 |
|---|---|---|---|---|
| B1 | Key 状态筛选纯 UI 摆设（写 URL 不发参数） | keys/page + keys-filter | 中 | 随 D-B 移除筛选 UI（契约无 status 参数） |
| B2 | `/v1/plans` 传 `page_size=100`（全仓契约是 `limit`）大概率被忽略截断 | subscription/page | 中 | **修复**：改 `limit=100`、去 `sort_by`（strict 契约）；回归用例 |
| B3 | orgs 列表 N+1（每行再拉详情） | orgs/page | 低 | 保留并发拉取（契约无批量端点）；挂 G2 |
| B4 | 活跃 Key 数只统计前 100 条 | dashboard/page | 低 | KPI 改信封 `total`（语义变化，MIGRATION §4） |
| B5 | by-model 响应双键（rows/list）只读一种，另一形态静默空白 | dashboard/page | 中 | 按新契约单形态消费（实施时以 routes/usage.ts 实测信封为准）；防御性兜底空数组 |
| B7 | auth 裸 fetch 丢 `x-forwarded-for`（IP 爆破锁把全员记成 Next 容器 IP）与 `accept-language` | lib/server-actions/auth.ts | **高** | **结构性修复**：全部调用经 `createNextClientApiClient`；回归用例断言出站头 |
| B8 | 日期格式化依赖容器本地 TZ；「今日」用 +8h 硬编码近似 | formatters + dashboard | 中 | `DISPLAY_TZ` env（默认 Asia/Shanghai）+ `createDateFormatter({timeZone})`；KPI 今日判断显式 TZ |
| B11 | 死文件 `src/data/users.ts` 全仓零引用 | data/users | 低 | 不移植 |
| B12 | 品牌串「Studio Admin」模板残留 | app-config | 中 | **修复**：TokenLens Console |
| B13 | get-user 注释自述调 admin-api，实际 client-api | get-user | 低 | 新实现注释如实 |
| B14 | tsconfig 死映射（`@/stores/*` 等指向不存在目录） | tsconfig | 低 | 新 tsconfig 仅 `@/*` |
| B15 | package.json 13 个零引用依赖（zustand/dnd-kit/embla/analytics/…） | package.json | 中 | 修剪（见 §3 依赖清单） |
| B17 | transactions 页 `userId:0`、`balanceBefore:''` 占位假数据 | transactions/page | 中 | 新游标契约真实字段（balanceBefore/After 均回传） |
| B18 | 导出仅当前页 20 条、TSV 无 BOM | export-keys | 低 | 保留行为（页面级导出语义），挂待办 |
| B19 | api-guide 直接信任 `x-forwarded-host` | api-guide | 低 | 保留（部署在可信代理后，仅展示层） |
| B20 | capabilities 探测失败按「开启」渲染 | login/register | 取舍 | 保留（v1 刻意：探测失败由提交 403 兜底） |
| B6 | playground/OAuth 浏览器同域依赖 nginx 分流 | next.config | 取舍 | 保留（dev 已知限制，DESIGN §9） |
| B9/B10 | 全站 force-dynamic、subscription 页重复拉 me | 多处 | 取舍 | 保留（App Router 语义，v1 等价） |

### 1.2 重复代码（D#）

| # | 内容 | 提取 |
|---|---|---|
| D1 | stripAuthParams / parseListSearchParams / listHref / money-tone / getInitials（旧 ui lib） | app 内 `features/shared/`、`server/list-query.ts` 单处实现 |
| D2 | `next` 回跳白名单逻辑三处复制（login-verify/register-verify/oauth） | `server/next-url.ts` 单点（含回归用例） |
| D3 | 一次性密钥/密文明文展示（keys/apps 两处手写） | 统一用 ui `SecretReveal` + 复制 |
| D4 | 订单状态 0-4 → pill 映射 | `features/wallet/order-status.ts` 单处表驱动 |

### 1.3 契约缺口（G#，演进决策）

G1 列表 `q`/排序参数缺失（usage/keys）；G2 orgs 批量详情端点缺失；G3 订单列表无 total；G4 plans 排序参数 strict 拒收（依赖后端默认序）。全部挂 client-api 后续扩展，UI 回补时不动 BFF 层以下。

## 2. 逐模块裁决表（63 文件，分组）

| 旧文件（组） | 裁决 | 动作 |
|---|---|---|
| app/layout、(auth)/layout、(main)/layout | 重写 | ui 根入口具名导入；ThemeProvider + app 内联 boot；去 geist/fontVars（ui styles 自带 Inter） |
| app/page（landing 382）、pricing/page | 复制+微修 | 取数改 `server/public-pricing.ts`（facade），展示组件下 features/public |
| (auth)/login、register 页 + 表单 + oauth-buttons + turnstile-widget | 复制+微修 | imports 换新面；响应 `kind` 判别（v1 已兼容）；actions 指向 server/actions/auth |
| oauth/callback（page+actions） | 复制+微修 | fragment 解析提取纯函数（可测）；next 白名单走 D2 |
| middleware、i18n/request | 复制+微修 | SESSION_COOKIE/resolveLocale 改自 api-client/next |
| config/app-config | 重写 | B12 修复；去未用 meta |
| data/users.ts | 不移植 | B11 |
| lib/server-actions/auth.ts | 重写 | B7：经 facade；结构按 DESIGN §4 |
| lib/server/get-user.ts | 复制+微修 | getMe 经 facade；注释修正 B13；DEV_FAKE_ME 保留 |
| lib/public-pricing.ts | 复制+微修 | 公开 facade（无 token）；pageSize 契约保持（pricing 专属宽松解析） |
| dashboard/page + 双图表 | 复制+微修 | B4/B5/B8；取数编排放页，图表组件去 features/dashboard |
| keys（page/actions/content/filter/export） | 复制+微修 | B1：去 filter；明文展示 D3；actions 经 facade |
| apps（page/actions/content） | 复制+微修 | 同上 |
| usage/page | 复制+微修 | D-B：去 q/排序，加 from/to/model 过滤（URL 状态） |
| transactions/page | 重写 | D-A：游标 + 加载更多 + 真实字段 B17 |
| billing（page/actions/topup-form） | 复制+微修 | D-C：去页码条；订单状态映射 D4 表驱动 |
| redeem（page/actions/form） | 复制+微修 | actions 经 facade |
| invite/page | 复制+微修 | 积分投影 D-E 去除（金额直显） |
| orgs（page/actions/content/accept） | 复制+微修 | B3 保留并发；邀请链接生成同 v1 |
| subscription（page/actions/content） | 复制+微修 | B2；幂等键不传（缺省服务端 uuid）；差价计算原样 |
| settings（page/actions/3 组件） | 复制+微修 | 改密轮换 cookie 同 v1 |
| playground（page+组件） | 复制+微修 | rewrites 4 端点原样 |
| api-guide（page+3 组件） | 复制 | shiki 高亮原样 |
| navigation/sidebar-items、components/shell/* | 复制+微修 | NavMain 自 app 内实现（新 ui 只有原语）；ThemeSwitcher 用 ui；LocaleSwitcher/AccountSwitcher app 内实现 |
| 旧 ui 被消费面（ListPage/DataTable/useActionResult/ConfirmAction/…） | 重写 | ListPage/useActionResult/ConfirmAction 为 app 业务装配（features/shared）；DataTable/StatusPill/KpiCard/CopyButton/chart/sidebar 等原语直用新 ui |
| 旧 api-client 被消费面（apiFetch/fetchUserList/formatters/session/i18n/types） | 重写 | facade `list()` 替 fetchUserList；DTO 用 `dto/client-api`；格式化按 DESIGN D-D/D-E；session/i18n 用 ./next |
| messages/{en,zh}.json | 复制+微修 | 按 D-A/D-B/D-E 增删 key；en↔zh 对齐测试锁死 |
| next.config.mjs、postcss、package.json、tsconfig | 重写 | B14/B15；ui styles 经 `@tokenlens/ui/styles.css`；安全头原样 |

## 3. 拆分决策

目标树见 DESIGN §7。要点：
- **server/**（纯服务端）：`api.ts`（`createClientApi(overrides?)` 装配工厂，测试可注 fetch/baseUrl）、`session.ts`（requireMe/userFromMe/DEV_FAKE_ME）、`list-query.ts`、`next-url.ts`（safeNext）、`public-pricing.ts`、`actions/{auth,oauth,keys,apps,orgs,subscription,settings,redeem,billing,locale}.ts`（"use server"，一动词一文件粒度按域聚合，单文件 ≤ ~150 行）。
- **features/**：域内组件 + 纯逻辑（校验 schema、映射表、KPI 推导均提 `.ts` 可测文件）；`shared/`（ListPage、useActionResult、ConfirmAction、format、tone、initials）；`shell/`（sidebar/header 装配）。
- **app/**：只做路由、取数编排、features 组合（薄，≤ ~200 行/页）。
- **依赖**：deps = `@tokenlens/{ui,api-client}`、next、react、react-dom、next-intl、zod、react-hook-form、@hookform/resolvers、recharts、shiki、lucide-react、clsx、sonner?（toast 经 ui re-export，不需直依赖）；devDeps = typescript、@types/{node,react,react-dom}、tailwindcss、@tailwindcss/postcss、postcss、vitest、@vitest/coverage-v8。**零**:zustand、next-themes、geist、@vercel/analytics、dnd-kit、embla、input-otp(直用 ui)、react-day-picker、date-fns、simple-icons、vaul、react-resizable-panels、cmdk、@tanstack/react-table、radix-ui、@base-ui/react、class-variance-authority、tailwind-merge、tw-animate-css、input-otp、shadcn（B15 全修剪——均为旧 ui 消费方式或模板残留）。

## 4. 测试计划（§9.1 步骤 5）

- **架构门禁**（`architecture.test.ts`）：`@tokenlens/*` 说明符白名单恰为 ui(. / .styles.css) 与 api-client(. / ./next)；全文禁 `@ai-gateway`；tsconfig paths 恰 `@/*`；`process.env` 只出现在 server/、config/、middleware 除外零容忍（features/app 禁直读 env）；actions/*.ts 首行 "use server"。
- **i18n 门禁**：en↔zh key 树全等；代码中 namespace 词表 ⊆ messages。
- **行为规格**（旧测试 0 个——行为等价判定以 §2 消费清单 + MIGRATION §1 清单为准，测试全部新建）：actions 族（auth 两步流/验证码/captcha code 透传/logout best-effort、keys patch 省略 undefined、orgs 邀请链接、subscription B2 回归、settings 改密轮换、redeem/billing 校验与 revalidate）；session 守卫（401→redirect、DEV_FAKE_ME 仅 dev）；list-query（垃圾形状/缺省/越界）；next-url 白名单（含 `//`、`https://`、空）；B7 回归（出站 accept-language/x-forwarded-for）；format/tone（-0、垃圾、zh/en 色调）；sidebar-items（referral 开关）；oauth fragment 解析；topup 金额 schema（1 分–10 万元界）；dashboard KPI 今日推导（TZ 注入）。
- **覆盖率**：include = src/server/**、src/config/**、features 内 `.ts` 纯逻辑；exclude = `src/app/**`（薄装配）、`*.tsx`（渲染测试切片 MIGRATION §8）、`src/i18n/**`（依赖 next-intl/server 请求上下文，node 门禁内不可加载——落地口径见 §6）。阈值 90/85 写死 vitest thresholds；口径与排除理由在案（client-api「装配面由 real 覆盖」同例，本 app real 面挂 §8 待办）。

## 5. 实施顺序（每阶段可独立验证）

1. 骨架：package.json / tsconfig / next.config / postcss / vitest.config / globals / messages / middleware / i18n / config。
2. server/ 全量（api、session、list-query、next-url、public-pricing、actions×10）。
3. features/shared + shell（ListPage、useActionResult、ConfirmAction、format、tone、sidebar 族、header 族）。
4. features 各域 + app 页面（公开 → auth → dashboard 族）。
5. __test__/ 全量 + 四门（typecheck/lint/test/build）+ 覆盖率报告。

## 6. 实施日志

- 2026-08-23：三件文档定稿（DESIGN 定稿 / 本图 / MIGRATION），开工。
- 2026-08-23：实施完成。落地要点与文档增量（同步裁决）：
  - **api-client DTO 补齐**（单一事实源）：`dto/client-api.ts` 新增 auth 步骤/oauth/pricing/usage 信封/钱包游标/支付/兑换/返佣/列表信封 19 类；修 3 处与 wire 漂移（`TransactionRow`→`StatementRow` 游标口径、`PlanOption`→`PlanRow` 全量字段、`OrgDetail.org` 去 ownerUserId）。
  - **Next 16 proxy 约定**：middleware.ts → src/proxy.ts（新代码不留废弃约定）。
  - **actionResult 提纯**：useActionResult 的 useCallback 包装无状态——改为纯函数 `features/shared/action-result.ts`（可直测，9 处消费点同步）。
  - **subscription 拆分**（B 案 max-lines 500）：content(139) + current-subscription(238) + plan-actions(229) + plan-format（周期词表单点）。
  - **features/apps → applications**：边界脚本按子串 `/apps/` 匹配，撞名改名（不动并行波次共享脚本）。
  - **覆盖率口径落地**：include = `src/server/**` + `src/config/**` + `src/features/**/*.ts`；排除 `.tsx`（渲染切片 MIGRATION §8）与 `features/shell/types.ts`（纯类型零语句）；`src/i18n/request.ts` 不计（依赖 next-intl/server 请求上下文，无法在 node 门禁内加载——行为由 e2e 切片覆盖）。
  - **消费形态修正**：Base UI `render` prop 替代 Radix asChild（全局 20+ 处）；ui CopyButton `value` prop；ToggleGroup 受控数组值。
  - 四门：typecheck 0 错 / lint 0-0 / 96 用例全绿 / build（19 路由 standalone）；覆盖率 94.36/86.62/98.61/97.38 ≥ 90/85/90/90；边界门禁 21 workspace 通过。
