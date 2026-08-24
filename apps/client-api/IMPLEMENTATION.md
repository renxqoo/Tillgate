# client-api 施工图（IMPLEMENTATION）

> 状态：已完成（四门全绿；行为对照清单见 MIGRATION §6，app.test.ts 逐项核销）

## 1. 旧实现审计结论（要点，完整清单见 MIGRATION §2）

- 老仓 15 个 service 的业务语义已由能力包整建吸收（accounts/identity/billing/observability），
  本 app 不移植 service 层——service 对应动词映射见 §3。
- v1 病灶（AGENT.md §11 E1/E3）：`error-map.ts` 的 instanceof 翻译表与 SUBSCRIPTION_HTTP
  手工映射 → 全部替换为 category 渲染 + FaceOverride；新仓禁回归。
- v1 隐患沿用修复：支付回调幂等（billing payments 已内建 status=2 幂等应答）；
  OAuth state 单次消费（identity GETDEL 语义）。
- D# 重复提取：分页/安全件/请求 ID/网络提取全部改用 `@tillgate/http` 出口；
  错误信封/本地化改用 `errorHandler`。

## 2. 目录与文件清单（src 树）

```
src/
├── index.ts              # bootstrap：config → 装配 → app → serve → shutdown（coverage 排除）
├── config.ts             # zod env schema + 生产 fail-fast + 组配置校验
├── assembly.ts           # 唯一装配根：db/redis/logger/otel + 全部 facade + 适配器绑定 + mailer 覆盖缝
├── app.ts                # createClientApiApp(deps)：onError/notFound/中间件序/路由挂载/healthz
├── shutdown.ts           # runtime.createShutdown 绑定（薄）
├── adapters/             # §DESIGN 5（db/composition 白名单域）
│   ├── account-read.ts  billing-read.ts  usage-read.ts  pricing-read.ts  subscription-read.ts
│   ├── redis-rate-counter.ts  redis-session-revocation.ts  redis-oauth-state.ts
│   └── smtp-login-mailer.ts  turnstile-captcha.ts
└── http/
    ├── error-face.ts     # composeErrorCatalogs + client 自有目录 + FaceOverride 表
    ├── contracts/        # auth.ts me.ts keys.ts apps.ts orgs.ts billing.ts
    │                     # usage.ts oauth.ts pricing.ts shared.ts
    ├── middleware/
    │   └── session.ts    # Bearer → identity.sessions.validate + 状态读（统一 401）
    ├── presenters/       # 行映射（内部字段不出 wire；Decimal 派生计算）
    │   └── keys.ts me.ts orgs.ts subscriptions.ts pricing.ts referrals.ts
    └── routes/           # 认证按动词拆三件（auth / auth-register / auth-login）
                            + keys apps orgs wallet redeem payments subscriptions usage oauth pricing referrals
```

测试：`__test__/` 平铺（铁律 14）——`architecture / config / app / shutdown`
（默认门禁）+ `app.real`（test:real 装配冒烟）；跨进程旅程在根 `e2e/client-journey/`（§6.1）。

### 2.1 §0.5 超长文件审计（单一职责聚合；repo 先例 commit b9d0dc6）

| 文件                       | 行数        | 审计结论                                                                            |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| src/assembly.ts            | ~499        | 单一职责（进程装配根）：全部可变值来自 config，无业务分支；目标树钉死唯一装配根不拆 |
| src/config.ts              | ~232        | 单一职责（env schema 声明 + 交叉校验）；纯声明式                                    |
| src/adapters/usage-read.ts | ~158        | 四查询动词共用窗口条件推导（同文件避免复制 windowConditions）；拆分收益为负         |
| auth 路由                  | 115/113/106 | 已按动词拆分（auth / auth-register / auth-login）                                   |

### 2.2 装配覆盖缝

`assembleClientApi(config, overrides?: { mailer?: Mailer | null })`——v1 同款：
E2E capture mailer 注入（journey.real 消费）；缺省按 SMTP 环境构造。

## 3. 老service动词 → facade 映射

| 老 service（行数）                               | 新对接                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth.service（505）                              | identity.{credentials,passwords,challenges,sessions,captcha} + accounts.{provisionLocalAccount,completeAccountOnboarding,getProfile,updateDisplayName} + 编排见 DESIGN §4 |
| oauth.service（320）                             | identity.oauth.{authorize,callback,findUser} + accounts.provisionOAuthAccount                                                                                             |
| payments.service（397）                          | billing.createPaymentsApi（composition 建 epay/stripe provider）                                                                                                          |
| subscription.service（95）                       | billing.SubscriptionsApi{purchase,change,renew} + subscription-read                                                                                                       |
| org.service（252）                               | accounts org/invitation 动词                                                                                                                                              |
| keys.service（222）                              | accounts.{createKey,listKeys,patchKey,rotateKey,revokeKey}                                                                                                                |
| apps.service（135）                              | accounts.{createApp,listApps,disableApp,rotateAppSecret}                                                                                                                  |
| redeem.service（104）                            | billing.createRedemptionApi                                                                                                                                               |
| wallet.service（25）                             | billing.wallet.{accounts,statement}                                                                                                                                       |
| usage.service（105）                             | adapters/usage-read                                                                                                                                                       |
| pricing.service（79）                            | adapters/pricing-read                                                                                                                                                     |
| referral.service（146）/ marketing.service（23） | accounts.{referralOverview,getMarketingSettings} + billing-read 佣金和                                                                                                    |
| health.service（18）                             | app.ts 内联（ping + redis）                                                                                                                                               |
| rate-counter（28）                               | adapters/redis-rate-counter                                                                                                                                               |

## 4. 错误码对照与 FaceOverride（v1 裸码 → 新码/状态）

catalog 装配：`composeErrorCatalogs(HttpErrors, identityErrors, AccountsErrors, BillingErrors, clientErrors)`。

`clientErrors = defineErrorCatalog('client', {...})`（app 自有编排目录）：
register_disabled(403) · register_rate_limited(429) · captcha_required(400) ·
two_factor_unavailable(503) · auth_guard_unavailable(503) · rate_counter_unavailable(503) ·
login_locked(429) · account_unavailable(403) · last_login_unavailable(503，写失败可观测不阻断) ·
oauth_state_mismatch(403) · oauth_state_expired(410) · oauth_callback_failed(502，上游换码/取档失败兜底)。

FaceOverride（状态与 category 默认不同的钉死项）：

| code（新）                          | override                               | v1 对应（旧码/状态）            |
| ----------------------------------- | -------------------------------------- | ------------------------------- |
| billing.code_expired                | 410                                    | code_expired/410                |
| accounts.invitation_expired         | 410                                    | invitation_expired/410          |
| client.oauth_state_expired          | 410                                    | oauth_state_expired/410         |
| client.oauth_callback_failed        | 502                                    | oauth_exchange_failed/502       |
| billing.payment_channel_unavailable | 502                                    | payment_channel_unavailable/502 |
| accounts.email_taken                | 409（conflict 默认）                   | email_taken/409                 |
| identity.invalid_credentials        | 401（category forbidden→403 需钉 401） | invalid_credentials/401         |
| identity.weak_password              | 400（invalid_input 默认）              | weak_password/400               |
| billing.insufficient_balance        | 402（quota_exhausted 默认）            | insufficient_balance/402        |

其余业务码走 `CATEGORY_STATUS_DEFAULTS`；`identity.identifier_taken`≈409、
`billing.invalid_code`≈404、`billing.code_already_used/revoked`≈409、
`accounts.seats_full/invitations_full`≈409、`accounts.org_forbidden`≈403 等由各包
category 声明决定，IMPLEMENTATION §4 表在 app.test.ts 用表驱动锁死。

## 5. API 对照（相对 v1 的全部变化点——实施后定稿）

1. 错误码命名空间化（DESIGN §1）；状态码经 §4 override 表保持（唯二例外见 5/6）。
2. JSON 请求体必须带 `content-type: application/json`（hono validator 语义；v1 裸
   `c.req.json()` 不判型）。校验失败统一 `http.validation_failed` 400（v1 invalid_request），
   路径参数失败 `http.invalid_path_param`。
3. `GET /v1/payments/channels` label 文案随 `PROVIDER_LABELS`（epay「支付宝/微信（易支付）」）。
4. Key 行不再回 `allowPaygFallback`；App 行不再回 `userId/subscriptionId`；Key 轮换响应
   不再回 `revokedId`（api-client DTO 口径；内部字段不出 wire）。
5. `billing.subscription_state`（no_subscription 场景）v1 404 → 409（单码带 reason 上下文，
   静态 override 无法按 context 分状态——记录为已接受漂移）。
6. 订阅购买/变更 `quantity` 缺省直传 undefined（facade 默认 1），行为等价。
7. captcha 判负经 identity 抛 `identity.captcha_invalid/captcha_unavailable`（v1 裸码同名
   去命名空间）；`identity.oauth_state_invalid` 统一 410（v1 区分 mismatch 403 / expired 410，
   cookie 双提交层保留 403 语义）。
8. 其余 51 路由的路径/方法/状态码/信封逐条对齐 v1（MIGRATION §6 行为对照清单）。

## 6. 测试计划（§10 标准）

### 6.1 真实链路与 E2E（test:real 通道，已核销）

- `app.real.test.ts`：装配 fail-closed + healthz 双检 + 公开端点 + 无 SMTP 注册 503 + 未知凭据 401 + usage adapters SQL 冒烟。
- 跨进程旅程归位根 `e2e/client-journey/`（总纲 §3；三套件：user-journey/oauth/org-team，
  mock GitHub 上游 + 签名 epay 回调 + 完整度矩阵见该目录 README）；app 内不保留副本（单一实现）。
  （历史：先在 app real 通道以 `journey.real.test.ts` 形式验证全链，后按总纲归位迁移并删除原文件。）注册两步制（capture mailer 收码）→ verify 建+号（挑战单次消费重放 400）→ me/改显 → Key 全生命周期（创建明文一次/修补/轮换/吊销）→ 钱包/用量/定价/套餐/组织/推荐只读面 → 兑换未知码 404 → 渠道目录空 → 登出 jti 即时吊销 → 错密码 401 防枚举 → 两级登录 → 改密全网下线 → 新密码复登。数据自清理（FK 逆序 best-effort）；环境经 vitest 配置自载根 .env（bun x 不透传 --env-file，实测确认）。
- **B-red-claim（E2E 抓出的跨包真 bug）**：billing postgres 兑换码 claim 的 `UPDATE ... RETURNING` 引用未 JOIN 的批次表列 → 裸列名 → PG 42703，兑换动词全路径 500（连未知码路径都炸）。修复：RETURNING 只留本表列，批次面额由同事务 SELECT 读取；回归用例 `packages/billing/__test__/redemption-claim.real.test.ts`（未知码 null / 有效码面额 / CAS 单赢家 / 过期码）。
- **B-tz-groupby**：usage 日汇总 `AT TIME ZONE` 参数化后 GROUP BY 与 SELECT 占位符不一致（$1≠$2）无法匹配——时区经 config 字符白名单校验后字面量入 SQL；测试同上旅程覆盖。
- 跨进程旅程（OAuth 跳转 / 支付回调验签 / gateway 联动）仍归根 `e2e/`（MIGRATION §8 待办——依赖 gateway 与渠道桩）。

- `config.test.ts`：默认值/覆盖/生产 fail-fast 矩阵/组配置全-or-无/secret 三闸（表驱动）。
- `app.test.ts`：**内存替身**驱动 `app.request(...)` 的 HTTP 契约测试——
  每路由域 happy path + 错误映射（状态 + 信封 code 表驱动）+ 会话中间件（缺/伪/吊销/封禁）+
  安全件（CORS 白名单、body 413 双路径、requestId 回显）+ logout + notify 双渠道应答协议。
  替身实现 app.ts 的窄接口（Deps 由 app.ts 自有 interface 声明——装配与测试同构）。
- `architecture.test.ts`：DESIGN §3 四门（文件集快照 + composition/db 白名单 + 深导入禁令）。
- `app.real.test.ts`（test:real 通道）：真实 PG + Redis 全链（注册→登录→Key→订阅→支付回调→
  兑换→对账）；adapters SQL 仅在此通道验证。
- 覆盖率：lines/statements/functions 90 · branches 85；排除 `src/index.ts` 与
  `src/adapters/*`（PG 集成件，real 通道覆盖——如实申报，不调阈值）。

## 7. 实施顺序（每步四门可过）

1. package.json/tsconfig/vitest + config.ts（+config 测试）
2. contracts + middleware + presenters + error-face
3. app.ts + app.test.ts（内存替身全量契约）
4. adapters + assembly + index/shutdown
5. architecture 测试收紧 + app.real.test.ts + 全门禁核销
