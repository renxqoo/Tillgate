# client-api 迁移文档（MIGRATION）

> 状态：已核销（默认门禁四门全绿；real 装配冒烟通过；跨进程旅程归位根 `e2e/client-journey/` 三套件全绿——含 mock OAuth 上游与签名支付回调；旅程抓出并修复 billing B-red-claim 真 bug，回归已入档）
> 迁移单元：用户控制台 REST API 整面（51 路由的 HTTP 面一次性切换；业务语义已在
> identity/accounts/billing 迁移单元中先行落地，本单元只迁协议/装配/编排面）
> 旧实现：ai-getway `apps/client-api`（src 4,540 行 + 测试 5,305 行；51 路由；20 测试文件 ~214 用例）
> 目标位置：本目录
> 关联：DESIGN.md · IMPLEMENTATION.md · 总纲 §9 P5/§9.1

## 1. 行为规格基线（旧测试清单 → 等价判定）

| 旧测试文件                                                                                                                          | 用例数 | 处置                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| frontend-contract.test.ts                                                                                                           | 11     | **改写**进 app.test.ts（wire 钉死项逐条保留：201/404/409 状态、`limit` 参数、金额字符串、rows 信封、密钥只回一次）                                 |
| app.test.ts                                                                                                                         | 13     | 改写（中间件序/错误信封/CORS/413/404）                                                                                                             |
| auth.test.ts(21) auth-code.test.ts(9)                                                                                               | 30     | 改写为 identity+app 两层：挑战/两级登录语义在 identity 包已有契约测试；app 层保留编排断言（信封/状态/防枚举）                                      |
| payments.test.ts(25) stripe-domain.test.ts(13)                                                                                      | 38     | 支付域语义已在 billing 包（payments/redemption 契约测试）；app 层保留路由协议（回调应答 success/fail、JSON received、404 未知渠道）                |
| subscriptions.test.ts(16) orgs.test.ts(14) keys.test.ts(7) apps.test.ts(8) redeem.test.ts(6) usage.test.ts(5) referrals.test.ts(14) | 70     | 能力语义归包测试；app.test.ts 保留每域 happy + 代表性错误映射                                                                                      |
| production-readiness.test.ts                                                                                                        | 5      | 改写进 config.test.ts（生产 fail-fast 矩阵）                                                                                                       |
| architecture.test.ts                                                                                                                | 4      | 重写为新边界门禁（composition/db 白名单、文件集快照）                                                                                              |
| e2e-user-journey(11)                                                                                                                | 11     | **改写核销**：核心链已由 `journey.real.test.ts` 在本 app real 通道覆盖（真实 PG/Redis/HTTP，§6.1）；跨进程部分（支付回调/OAuth 上游）仍归根 `e2e/` |
| e2e-org-team(3)/oauth(12)/cross-app(3)                                                                                              | 18     | **暂缓**：跨进程 E2E 归根 `e2e/`（P5 收尾统一搬迁，总纲 §9 P5）；依赖 apps/gateway 未建成，MIGRATION §8 挂待办                                     |

## 2. 审计结论（引用 IMPLEMENTATION §1）

影响本单元的 v1 真 bug / 缺口：

- B(v1)：instanceof 错误翻译表 → 新仓 category 渲染（已裁决，禁回归）；
- B(v1)：挑战载荷若存明文密码 → 本单元以 cipher 信封保持「不落明文」语义（DESIGN §4）；
- 契约缺口 G1/G2/G4（钱包富化/佣金和/find-or-create 归 app 组合）由 accounts 包注释显式预留，本单元实现。

## 3. 逐模块裁决表

| 旧文件                                            | 裁决      | 动作                                                                                    |
| ------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| index/config/shutdown/app/middleware×3            | 重构      | 按 trace-receiver/gateway 范式重写；安全件改用 @tokenlens/http                          |
| http/error-map.ts                                 | 重写      | error-face.ts（catalog + override；instanceof 表禁入）                                  |
| routes/*.ts（14）                                 | 复制+微修 | zod 拆入 contracts/；RunContext 删除（facade 直收窄参）；呈现入 presenters/             |
| services/*.ts（15）                               | 不移植    | 语义已在能力包（IMPLEMENTATION §3 映射表）                                              |
| domain/{topup,stripe,epay,referral,key-limits}.ts | 不移植    | billing/accounts 域内已有（isValidAmountInput/assertTopupWithinLimit/pickCoefficient…） |

## 4. API 对照

见 IMPLEMENTATION §5（错误码命名空间化 / channels 文案 / Key 行去 allowPaygFallback /
其余 51 路由逐条对齐）。

## 5. 测试迁移矩阵

见 §1 处置列；app.test.ts 为新等价判定的主载体，coverage 排除项与理由见 IMPLEMENTATION §6。

## 6. 行为对照清单（验收核销用）

1. 注册恒两步（无 SMTP → 503 two_factor_unavailable，绝不单步成功）；
2. verify 成功 201 {kind:success, token, userId, email, gifted}；email 竞态 409；
3. 登录爆破锁 429 + Retry-After；统一 401 防枚举；封禁 403 account_unavailable；
4. 改密后旧 token 立即失效（吊销线）、返回新 token；
5. 会话中间件统一 401（不区分原因）；
6. Key/App/邀请凭证只回一次明文；rotate 201 / 200 语义与 v1 一致；
7. 兑换 429/404/409/410 语义族 + history 信封；
8. 支付下单 201 {orderId,payUrl,creditAmount}；epay 回调裸文本 success/fail；stripe JSON
   received + 非 2xx 触发渠道重试；重复回调幂等 success；
9. 订阅幂等（idempotency-key 头；非法形态 400）；mySubscriptions 个人有效订阅优先；
10. usage 日汇总为北京时间日桶；rate 为 60s 窗 rpm/tpm；
11. pricing 公开目录 q/free 过滤 + 分页（pageSize≤500）；personal 含 coefficient/effective；
12. wallet 游标分页 nextCursor 仅在满页出现；
13. OAuth state cookie 双提交 + fragment 回传 #token=；
14. /healthz：DB+Redis 双检，Redis 不可达 503。

## 7. 回滚方案

单仓新增目录（不动老仓）；revert 即整体消失。DDL：无（本单元不携带 schema 变更）。

## 8. 待办（显式挂账，非本单元范围）

1. usage-read / subscription-read / billing-read / account-read 迁入对应能力包 facade
   （billing 需补用户面 usage 查询与 plans/mySubscriptions 读动词；accounts 需补
   emailTaken/activeUserStatus/touchLastLogin）——迁入后删 app 适配器并收紧
   architecture 白名单；
2. ~~根 e2e/ 搬迁 client-journey E2E~~——**已兑现**（`e2e/client-journey` 三套件全绿于
   真实 PG/Redis/HTTP：user-journey（注册两步制→Key→兑换→epay 下单→签名回调入账→
   重复回调幂等→金额篡改拒绝）、oauth 跳转、org-team；提交 e965ca2）；
3. api-client DTO 快照与本实现联调核对（`/v1/me/transactions` 等 DTO 疑似超前项，
   以本实现 51 路由为准修订 DTO）；
4. OpenAPI 生成链接入后 contracts/ 目录升级为生成源（总纲 P3/P6）。
