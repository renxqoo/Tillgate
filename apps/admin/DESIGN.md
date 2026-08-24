# @tokenlens/admin 设计基线（Next.js 管理后台）

> 状态：定稿（2026-08-23）
> 定位：总纲（docs/project-structure-refactoring.md）§3 目标树 `apps/admin`——Next.js 管理后台。
> 施工图见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)，v1 行为规格映射见 [MIGRATION.md](./MIGRATION.md)。

## 1. 外部契约

### 1.1 页面契约（URL 不变，v1 逐条保持）

路由与 v1 完全一致（浏览器书签/外链不破）：

- `/` 落地页 → `/login`；`/login`（email+password，2FA 邮箱码两步）
- `/dashboard` 总览（KPI + 趋势图）；`/dashboard/{users,users/:id,providers,channels,
models,rate-cards,rate-cards/:id,rate-limits,settings,plans,subscriptions,channel-funds,
marketing,referrals,payment-orders,model-market,redeem-batches,redeem-batches/:id,
notifications,billing-operations,tracing,tracing/topology,logs,usage-logs,audit-logs}`
- `/api/vouchers/:key`（渠道入货凭证代理读，内部端点）

所有数据页面 `force-dynamic`（管理面实时性；不经 Next 数据缓存）。

### 1.2 数据契约（唯一来源：admin-api + `@tokenlens/api-client`）

- 全部取数/变更经 `createNextAdminApiClient()`（`@tokenlens/api-client/next`），
  路径白名单 `/v1/*`，会话=BFF 持有 `sk_admin_session` HttpOnly cookie → 出站 Bearer。
- wire DTO 以 `@tokenlens/api-client` 手写快照为编译期事实源（生成链落地前唯一事实源，
  总纲 §2.2）；本波补齐 tracing 族等 admin 消费缺口（IMPLEMENTATION §4）。
- **前端零直连能力包**：不 import `@tokenlens/{ai,inference,tracing,db,http,runtime,
identity,accounts,billing,control-plane,notifications,observability}`——架构测试机器锁定
  （总纲 P5「清除 apps/admin 对 ai/tracing 直依赖」的前端半边）。

### 1.3 会话与守卫契约

- 登录/验码：server action 直调 admin-api `POST /v1/auth/login`、`/v1/auth/login/verify`
  （裸 fetch——登录前无会话 client），token 写 `sk_admin_session`（HttpOnly/SameSite=lax/
  生产 Secure），出站由 client getToken 注入 Bearer。
- 守卫：`(main)` layout `requireAdmin()` = client.getAdminMe()（`GET /v1/me`），失败重定向
  `/login`；`/v1/me` 由 admin-api P2 波提供（本波运行时依赖，见 §5）。
- 注销：`POST /v1/auth/logout` 吊销 jti（best-effort）+ 清 cookie。

### 1.4 i18n 契约

next-intl 无路由模式（cookie `NEXT_LOCALE` → Accept-Language → 默认 en）；词表
`messages/{en,zh}.json` v1 全量平移。语言协商内核复用 `@tokenlens/api-client/next` 的
`resolveLocale/LOCALE_COOKIE`（D1 孪生实现已在包侧）。

## 2. 问题域（处理 / 不处理）

**处理**：管理面全部页面装配、BFF 会话编排、表单校验（前置 UX 校验）、URL 列表状态
（page/limit/筛选参数）、i18n、主题、导出 CSV（客户端投影）、链路图前端布局（dagre/
xyflow 纯前端计算）。

**不处理**（归属）：

- 业务规则/事务/SQL——admin-api 身后的能力包；前端只做 wire 调用与展示。
- 协议词表权威源——`ai`→capabilities→admin-api `/v1/vendor-catalog`（P6）。P6 落地前
  providers 表单协议下拉用 `src/config/protocols.ts` 本地快照过渡（后端 zod 仍是最终
  防线；快照来源与切换裁决见 IMPLEMENTATION §6）。
- 资金不变量、审计落库、通知投递——billing/observability/notifications。
- 组件设计系统——`@tokenlens/ui`；Next 耦合组合件（action-toast/list-page 等）按
  ui 包纪律（禁 Next 专有依赖）owned by app（IMPLEMENTATION §3 裁决表）。

## 3. 结构（目标树落位）

```text
apps/admin/
├── package.json / tsconfig.json / next.config.mjs / postcss.config.mjs / vitest.config.ts
├── messages/{en,zh}.json
├── src/
│   ├── app/                          # 路由与页面装配（薄壳：取数 + 组 features）
│   │   ├── layout.tsx / page.tsx / globals.css
│   │   ├── (auth)/{layout,login}
│   │   ├── (main)/layout.tsx + dashboard/**（每页 ≤ 取数+组装）
│   │   └── api/vouchers/[key]/route.ts
│   ├── features/                     # 业务域组件与逻辑（client 组件为主）
│   │   ├── users/ channels/ models/ billing/ tracing/
│   │   ├── auth/ settings/ notifications/ dashboard/
│   ├── server/                       # BFF adapters 与 server actions（目标树原注）
│   │   ├── admin-api.ts              # createNextAdminApiClient 唯一调用点（请求级）
│   │   ├── get-admin.ts              # requireAdmin 守卫
│   │   └── *-actions.ts              # 全部 "use server" 动词（按域一文件）
│   ├── components/                   # app 壳与 app-owned 组合件（shell/列表基座等）
│   ├── config/                       # app-config / protocols 过渡词表 / i18n request
│   └── lib/                          # 纯前端工具（list-query/money-tone 等 app 版）
└── __test__/                         # 铁律 14：包根平铺（目标树 test/ 由铁律 14 统一）
```

features 域映射（目标树注释五域的落位）：

| 域                                          | 页面                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| users                                       | users、users/:id                                                                                                          |
| channels                                    | providers、channels、rate-limits                                                                                          |
| models                                      | models、model-market（model-catalog）                                                                                     |
| billing                                     | rate-cards、plans、subscriptions、channel-funds、payment-orders、redeem-batches、billing-operations、marketing、referrals |
| tracing                                     | tracing、tracing/topology、logs、usage-logs、audit-logs                                                                   |
| auth / settings / notifications / dashboard | login、settings、notifications、dashboard 总览                                                                            |

## 4. 关键行为口径

- **金额**：一律字符串（wire numeric 字符串），展示经 ui `MoneyDisplay`/`createMoneyFormatter`；
  表单校验正则（`^-?\d+(\.\d+)?$` 等）v1 语义平移；零 IEEE-754 运算。
- **列表**：URL 查询参数持有 page/limit/筛选（可分享/可回退）；服务端分页信封
  `{rows,total,page,limit}`；limit 白名单与后端 listQuery 同口径。
- **变更动作**：server action 返回 `{error?}` 形状（不 throw 到客户端），成功
  `revalidatePath` 对应路径；错误 message 英文（wire `error.message`），本地化文案由
  页面按 ApiError.code/message 渲染（铁律 18）。
- **凭证上传**：渠道入货凭证 base64 ≤2MB，server action bodySizeLimit 5mb（v1 语义）。
- **主题**：`data-theme-mode` + 首帧 boot script（无闪变）；语言/主题 cookie 均一年。

## 5. 运行时依赖矩阵（admin-api 待落端点 → 前端页面）

本波前端先行；下列端点未落地前对应页面运行时报错（显式失败，不静默降级）。
admin-api IMPLEMENTATION §3 波次为准：

| admin-api 波次 | 端点                                                                                   | 消费页面                                  |
| -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| P2             | /v1/auth/login(+/verify)/logout、/v1/me、/v1/me/two-factor、/v1/users/:id/set-password | login、全站守卫、settings、用户详情       |
| P3             | /v1/marketing/settings、/v1/referrals/*                                                | marketing、referrals                      |
| P4             | /v1/stats/*、/v1/usage-logs、/v1/analytics/channel-ttft、/v1/payment-orders(+/close)   | dashboard、usage-logs、payment-orders     |
| P5             | /v1/notifications*、/v1/vouchers/:key                                                  | notifications、渠道入货凭证预览           |
| P6             | /v1/vendor-catalog                                                                     | providers 协议/档案词表（过渡快照切换点） |

## 6. 安全

- 浏览器安全头 v1 同款（CSP/frame-ancestors none/nosniff/referrer/permissions），
  `output: 'standalone'`，`removeConsole` 生产开启。
- BFF 是唯一持 token 方；浏览器永不见 JWT；出站自动附 accept-language 与
  x-forwarded-for（trusted proxy 解析）。
