# apps/client 设计基线（DESIGN）

> 状态：定稿
> 定位：总纲 `docs/project-structure-refactoring.md` §3 目标树 `apps/client`（Next.js 用户控制台），P5 波次第四个 app、新仓**第一个 Next.js 应用**——它建立的 BFF 消费范式是后续 `apps/admin` 的样板。
> 旧实现：`/Users/wrr/work/ai-getway/apps/client`（63 文件 / 7091 行，无测试）。
> 关联：IMPLEMENTATION.md（审计与施工图）/ MIGRATION.md（行为规格与迁移矩阵）。

---

## 1. 外部契约（用户可观察行为）

部署单元：Next.js 16 App Router，`output: 'standalone'`，端口 3001（沿用 v1）。三种访客形态：

1. **公开页**（无需会话）：营销首页 `/`（含免费模型广场，取公开定价前 9 条）、`/pricing` 公开定价表（`q`/`free` 搜索 + 分页，pageSize=50）、`/login`、`/register`（Cloudflare Turnstile 人机验证，能力探测失败按「开启」渲染、提交 403 兜底——v1 刻意取舍）、`/oauth/callback`（读 URL fragment `#token=` 换 BFF cookie 后跳 `next`）。
2. **受保护页**（middleware 查 `ag_session` cookie 存在性 + layout `requireMe()` 权威校验，双层）：`/dashboard`（KPI + 双图表）、`keys`、`apps`、`usage`、`transactions`、`billing`（充值+订单）、`redeem`、`invite`（返佣，功能开关可关）、`orgs`（+`orgs/accept?token=`）、`subscription`、`settings`、`playground`（BYOK 同域直连推理端点）、`api-guide`。
3. **i18n**：无路由 cookie 模式（`NEXT_LOCALE` → `Accept-Language` → en），en/zh 双语全量 SSR，切换无闪变。

写入动作全部经 Server Action（BFF 代理到 client-api），错误以 toast 呈现，message 语言与 UI 一致（BFF 转发 `accept-language`，后端本地化）。

## 2. 问题域

**处理**：页面路由装配、BFF 会话持有（HttpOnly cookie ↔ Bearer JWT 互转）、出站头注入（accept-language / x-forwarded-for）、Server Action 编排（校验→转发→落 cookie→revalidate/redirect）、i18n 词表与语言切换、展示格式化（金额/日期/数字，装配注入 locale/TZ/币种）、纯前端交互态（表单、图表、筛选 URL 状态）。

**不处理**（归属已定，不留白）：

- 业务规则/事务/SQL → 能力包（identity/accounts/billing/…），唯一入口 `apps/client-api`；
- 会话签发/校验、挑战/验证码、OAuth 状态机 → client-api（本 app 只持 cookie、不解释 JWT）；
- 错误码目录与本地化 → client-api error-face（本 app 只透传 `error.message` 展示、按 `code` 做极少数 UI 分支如 CAPTCHA 换票）；
- 设计系统 → `@tillgate/ui`（本 app 零第二套视觉原语；app 内组件仅业务装配）；
- transport/DTO → `@tillgate/api-client`（本 app 零手写 fetch 细节、零第二套 DTO）；
- 计费/对账/渠道 → billing/inference 能力面。

## 3. 消费面契约（依赖只此两家 + Next 生态）

| 依赖                    | 消费方式                                                                                     | 硬约束                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@tillgate/ui`         | 根入口 `@tillgate/ui` 具名导入 + `@tillgate/ui/styles.css`                                 | 禁 `next/*` 专有能力进 ui（包内自锁）；app 不 import `./components/*` 子路径以外的私货 |
| `@tillgate/api-client` | `.`（类型 + `ApiError` + facade）与 `./next`（session/locale/forwarded-ip/clients BFF 装配） | 仅此两条 exports；app 零直接 fetch 后端、零手写 DTO                                    |
| 其他 `@tillgate/*`     | **一律不依赖**                                                                               | 由 `__test__/architecture.test.ts` + `scripts/check-package-boundaries.ts` 机器锁定    |

client-api 消费子集（51 路由中的 41 条）：auth 7、me 2、keys 5、apps 4、orgs 7、wallet 2、redeem 2、payments 4（notify 除外）、subscriptions/plans 5、usage 4、oauth 3（providers/authorize 入口/callback 回跳）、pricing 2（personal 备用）、referrals 2、healthz 不消费。

**契约差异裁决**（相对 v1 行为，详见 MIGRATION §4）：

- D-A 钱包流水：v1 `?page=&limit=&sort_by=&order=&q=` → 现**游标分页** `?limit=&beforeLegId=`，UI 从页码条改「加载更多」；
- D-B usage/keys 列表：契约 strict 只收 `page/limit`（usage 另收 `from/to/model`）→ v1 的 `q` 搜索与列排序 UI **移除**（契约缺口 G1，后端扩展后回补）；
- D-C 订单列表：响应只 `{rows}` 无 total → 去页码条，按页「加载更多」（G3）；
- D-D 金额展示：v1 字符串截断 4 位 → Intl 货币格式 2–4 位自适应四舍五入（信息量保留，舍入方式变化）；
- D-E 积分投影（×100）：新契约无积分概念，废除；
- D-F 主题：cookie+ui 注册表 → ui `ThemeProvider`（localStorage `theme`）+ app 内联 boot 脚本防 FOUC。

## 4. BFF 模型（会话/语言/IP）

- **会话**：后端无 Cookie 纯 Bearer；浏览器侧 `ag_session` HttpOnly(lax, 生产 secure, path=/, TTL=SESSION_TTL_SECONDS) 持 JWT，由 `@tillgate/api-client/next` session 工具读写；登录/验码/OAuth 回调/改密从响应体取 `token` 落 cookie；登出先 best-effort 吊销 jti 再清 cookie。
- **出站头**：一切后端调用经 `createNextClientApiClient()`（自动注入 `authorization` + `accept-language` + `x-forwarded-for`——v1 auth 裸 fetch 丢头病灶 B7 的结构性修复）；`TRUSTED_PROXY_HOPS` 解不出用户 IP 则不带 XFF。
- **开放重定向防线**：`next` 参数站内白名单（`/` 开头且非 `//`，缺省 `/dashboard`）单点实现于 `src/server/next-url.ts`，登录/验码/OAuth 三处复用（D2 去重）。
- **鉴权双层**：middleware（cookie 存在性，快速门卫 + `next` 透传）+ `requireMe()`（`getMe()` 权威校验，失败 redirect `/login`）；`DEV_FAKE_ME=1`（非生产）注入演示会话。

## 5. i18n 模型

- 词表：`messages/{en,zh}.json`（v1 628 key 双语对齐迁移，按 D-A/D-B/D-E 增删）；key 树 en↔zh 全等由 `__test__/i18n-parity.test.ts` 锁死。
- 解析：`src/i18n/request.ts` 用 `@tillgate/api-client/next` 的 `resolveLocale`（cookie → 头 → en），无路由段、SSR 全量渲染。
- 切换：app 自有 Server Action `setLocaleAction` 写 `NEXT_LOCALE`（v1 由 ui 包 server action 承担，P7 ui 禁 server 依赖后归 app）。

## 6. 并发与性能预算

- 每页后端拉取 `Promise.all` 并行；单页扇出 ≤5（orgs 列表逐行详情为契约缺口 G2，限页大小 20、并发拉详情，记待办）。
- 全部受保护页 `force-dynamic`（控制台实时性语义，v1 等价）；公开定价页走 client-api Redis 缓存 + Next 默认动态。
- 客户端 bundle：ui 具名导入（tree-shake 到 P6/P7 优化，已知代价）；图表 recharts 仅 dashboard/playground 页引入。
- Server Action 返回 `{error?, code?, ...}` 形态，异常reject 不允许——fetch 级失败翻译为可见 error（v1 病灶语义保留为显式契约）。

## 7. 目录结构（总纲 §3 原样落地）

```
apps/client/
  messages/{en,zh}.json
  src/
    app/            # 路由与页面装配（薄：取数编排 + 组合 features）
      (auth)/ (main)/dashboard/ oauth/callback/ pricing/ api-guide 属 features/public
    features/       # auth/keys/apps/orgs/usage/wallet/subscription/invite/settings/playground/dashboard/public/shared/shell
    server/         # BFF：api.ts(装配) session.ts(守卫) list-query.ts next-url.ts public-pricing.ts actions/*.ts
    config/         # app-config（品牌/版本）
    i18n/request.ts
    middleware.ts
  __test__/         # 平铺（铁律 14），vitest include 固定
```

## 8. 安全

- middleware matcher `/dashboard/:path*`；CSP（v1 等价）：`challenges.cloudflare.com` 放行 script/frame，`connect-src 'self'`（playground 同域推理），frame-ancestors none + XFO DENY。
- cookie 全 HttpOnly；token 经 URL fragment（OAuth 回跳）不进日志/Referer，落地即换 cookie 并 `location.replace` 清址。
- 输入校验双层：页面表单 zod（用户即时反馈）+ client-api 契约（权威）；金额输入十进制字符串上界 10 万元（v1 等价）。

## 9. 已知取舍与待办（显式挂账，不留白）

- 组件渲染测试（jsdom/testing-library）与真实链路 e2e：`__test__` 先覆盖 server/纯逻辑层 + 架构门禁；渲染与 e2e 归组独立切片（MIGRATION §8，同 gateway 先例）。
- G1（列表 q/排序契约）、G2（orgs 批量详情）、G3（订单 total）为 client-api 侧后续扩展点，扩展后 UI 回补。
- dev 无 nginx：`/v1/oauth/:provider/authorize` 浏览器直连不可达（v1 等价限制，next.config 只代理 4 个推理端点防劫持事故重演）。
