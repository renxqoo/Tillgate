# 修复记录（TDD：先 RED → 改码 → GREEN）

> 7 个缺陷已全部修复，采用「组件化、可扩展、不兼容旧行为」的方案；废弃旧代码已直接删除。
> 每个条目给出：根因 → 改法 → 涉及文件 → 测试（RED→GREEN）。

## 06 · 计费：成功订单被字节数当 token 硬上限误判 dead（资损，最高优先）

- **根因**：`packages/ledger/src/billing-flow.ts` 的 `validateReceipt` 把「UTF-8 字节数上界」当真实
  token 硬上限（`inputTokens > inputTokenUpperBound → dead`）。MiniMax 会报告隐藏的 system/cached token，
  `prompt_tokens=181` 远大于请求体字节数 ≈106，导致成功订单全部 `dead`、永不扣费（白嫖）。
- **改法**：删除这条 token 计数硬上限（以及为此引入的 `BillingUsageExceedsAuthorizationError` 类与
  `request.succeeded` 里的死账分支）。真正的资损不变量是**金额**：`settleClaim` 的
  `calculated > reserved → invariant_violation → dead` 已确保绝不超预扣扣款，收据校验只保留
  结构/授权合法性（estimated/负值/cached>input/user-mismatch/not-authorized）。`inputTokenUpperBound`
  字段保留但只用于「预扣估算」，不再用于拒绝结算。
- **涉及**：`packages/ledger/src/billing-flow.ts`、`apps/gateway/src/services/pipeline/llm-pipeline.ts`（注释口径修正）。
- **测试**：`packages/ledger/src/__tests__/billing-flow.test.ts`
  - RED：新增「inputTokens 超字节上界但金额未超预扣 → 应 settlement_pending → settled」用例（修复前返回 dead）。
  - 原「实际金额超预扣 → dead」用例改为「结算阶段 dead」（金额不变量），仍 RED 后转 GREEN。
- **E2E**：`06-billing-settlement-minimax.mts` 转绿（settled，实收 ¥0.00023226，reserved 归 0）。

## 08 · 上游 429 错误码命名不匹配 → 预留被误冻结 uncertain（资损）

- **根因**：`packages/ai/src/errors/classify.ts` 对 429 返回 `code: bodyCode ?? 'rate_limited'`，把 MiniMax
  body 里的 `rate_limit_error` 原样透出；而 gateway 的 `upstreamCharge()` / `isChannelSwitchable()` 只认
  `rate_limited` → 失败订单既不扣费也不退款、不做渠道切换，冻结为 `uncertain`。
- **改法**：429 一律归一为规范码 `rate_limited`（供应商原始 code 保留在 `rawBody` 供审计）；
  `quota_exhausted`（永久额度耗尽）仍单独区分且不可重试。并补 `quota_exhausted` 进 `upstreamCharge` 的
  「无扣费」清单（429 明确未处理）。
- **涉及**：`packages/ai/src/errors/classify.ts`、`apps/gateway/src/services/pipeline/llm-pipeline.ts`。
- **测试**：`packages/ai/test/unit/classify.test.ts`
  - RED：`429 rate_limit_error → code=rate_limited`（修复前断言 `rate_limit_error`）。
- **E2E**：`08-concurrent-billing-minimax.mts` 转绿（上游 429 全部 `released`、0 个 `uncertain|rate_limit_error`）。

## 01 · 登录时序侧信道 → 用户名/邮箱可枚举

- **根因**：`verifyPassword` 对 `null/非法` 哈希直接 `return false`（无 scrypt），登录流程里
  `user ? verify : false` 让「用户不存在」≈3ms、「密码错」≈42ms。
- **改法**：`verifyPassword` 改为**恒定时间**——哈希缺失/非法时对**固定哑哈希**（懒生成一次并缓存）
  跑等量 scrypt 后返回 false；登录流程无条件调用 `verifyPassword(password, user?.hash ?? null)`。
- **涉及**：`packages/identity/src/password.ts`、`apps/client-api/src/services/auth.ts`、
  `apps/admin-api/src/routes/admin-auth.ts`。
- **测试**：`packages/identity/src/__tests__/password.test.ts` 新增时序用例（dummy 路径耗时 ≥ 真实错密码路径的 50%）。
- **E2E**：`01-login-timing-user-enumeration.mts` 转绿（中位差 -0.3ms < 15ms）。

## 02 · 登录锁定 DoS：任意账号（含管理员）可被匿名锁死

- **根因**：`login-throttle.ts` 的 identifier-only 维度硬锁 10 分钟、不绑 IP → 匿名者 5 次错误密码即锁死目标。
- **改法**（组件化重构）：
  - 硬锁只绑 `(identifier, ip)`（攻击者只能锁「自己来源 + 账号」组合）。
  - identifier-only 降级为**分布式爆破观测信号**（仅计数，阈值 100，绝不锁定）。
  - **正确密码豁免**：登录流程先恒定时间校验，密码正确即清零放行（攻击者无法用错误密码锁死合法用户）。
  - 删除已无用的 `checkLoginThrottle`；`recordLoginFailure` 返回 `{locked, retryAfterSec}`。
- **涉及**：`packages/identity/src/login-throttle.ts`、`packages/identity/src/index.ts`、
  `apps/client-api/src/services/auth.ts`、`apps/admin-api/src/routes/admin-auth.ts`。
- **测试**：`apps/client-api/src/routes/auth-login-throttle.test.ts`、`auth-throttle-xff.test.ts` 重写为新语义
  （单源 429 + 正确密码 200；分布式换 IP 不再锁死账号）。
- **E2E**：`02-login-lockout-dos.mts` 转绿（5 次错后正确密码 200）。

## 03 · CSRF：状态变更接口缺 Origin/Referer 服务端校验

- **根因**：client-api / admin-api 仅依赖 SameSite=Lax Cookie，无 Origin 校验，跨源请求照常执行业务。
- **改法**：新增可复用组件 `packages/http/src/csrf.ts`（`csrfProtection({trustedOrigins})`）——
  状态变更方法校验 Origin（回退 Referer origin），不匹配 403；非浏览器客户端（无 Origin/Referer）放行。
  挂到 client-api / admin-api 受保护子应用；`trustedOrigins` 由 env `CSRF_TRUSTED_ORIGINS` 注入。
- **涉及**：`packages/http/src/csrf.ts`（新增）、`packages/http/src/index.ts`、
  `packages/core/src/env.ts`、`apps/client-api/{config,app,index}.ts`、`apps/admin-api/{config,app,index}.ts`。
- **测试**：`packages/http/src/__tests__/csrf.test.ts`（新增 5 用例）。
- **E2E**：`03-csrf-missing-origin-check.mts` 转绿（evil Origin → 403）。

## 07 · 鉴权失败路径无来源级限流 → 可无限刷 401 / 打爆日志与 Redis

- **根因**：RPM/TPM 限流在鉴权之后；per-key brute-force 只按 keyHash 计数（换随机 Key 即绕过），
  且无效 Key 也写 `request_logs` + 累积 `auth:fails:{hash}` 键。
- **改法**：
  - 新增 `apps/gateway/src/middleware/auth-failure-guard.ts`：`AuthFailureGuard`（按来源 IP 计数失败，
    窗口内达阈值 → 429）+ `sourceIp()`（XFF → X-Real-IP → socket `getConnInfo`）。
  - `AuthService.authenticate(header, sourceIp)` 采用**正确凭证豁免**：有效 Key/JWT 永不受来源历史失败影响，
    只有「本次也失败」才累计并可能 429。
  - 无效 Key 不再写 per-key `auth:fails:{hash}`（随机 Key 的限流统一交给来源级 guard，杜绝海量键打爆内存）。
  - `request-log` 跳过「429 且无 auth 上下文」的写库（前 N 次 401 仍记录以观测爆破）。
- **涉及**：`apps/gateway/src/middleware/auth-failure-guard.ts`（新增）、`auth.ts`、`request-log.ts`、
  `apps/gateway/src/services/auth/auth-service.ts`、`apps/gateway/src/app.ts`、`packages/core/src/env.ts`
  （新增 `GATEWAY_AUTH_FAILURE_LIMIT`/`GATEWAY_AUTH_FAILURE_WINDOW_S`）。
- **测试**：`apps/gateway/src/middleware/__tests__/auth-failure-guard.test.ts`（新增：单测 + 集成 429）。
- **E2E**：`07-auth-failure-no-rate-limit.mts` 转绿（30 无效 Key → 9×401 + 21×429）。

## 04 · JWT（App）路径绕过每用户 RPM 限流

- **根因**：`authenticateJwt` 置 `userRpmLimit/userTpmLimit=null`，管线退回 `DEFAULT_USER_RPM=60`，
  管理员设的更严限流被 JWT 静默无视。
- **改法**：JWT 路径与静态 Key 对称，从 `users` 表加载 `rpm_limit/tpm_limit`（60s Redis 缓存，缓存键
  `user_profile:{id}` 替换原 `user_status:{id}`，同时承载 status + rpm/tpm）。
- **涉及**：`apps/gateway/src/services/auth/auth-service.ts`、`apps/gateway/src/middleware/__tests__/auth-jwt-user-status.test.ts`（缓存键名同步）。
- **测试**：`apps/gateway/src/middleware/__tests__/auth-jwt-user-rate-limit.test.ts`（新增 2 用例）。
- **E2E**：`04-jwt-rate-limit-bypass.mts` 转绿（JWT 第 2 次 429，与静态 Key 同维度共享每用户限额）。

---

## 计费架构重构：预授权冻结 → 信用模型（事后扣 + 透支上限兜底）

> 这是「预扣不合理」问题（单笔 ¥2+、累积挤压可用余额导致 402 中断）的根治重构，非最小改动。

- **问题根因**：旧模型 `authorize` 按「峰值」冻结预留——`reserved_balance += 预估`，且要求 `balance - reserved >= 预估`；
  预估 = `字节数 × 输入价 + max_tokens × 输出价`（字节数对中文高估 ~3 倍、max_tokens 是「上限」不是「预期」）。
  并发/连续任务时 reserved 累积到 10+，`available = balance - reserved` 被挤空 → 402。
- **重构方案（对齐 OpenAI/Anthropic 事后扣费 + 信用卡信用模型）**：
  1. `users.credit_limit` 新增透支上限（默认 0）；`balance` 允许为负（≥ -credit_limit）。
  2. `authorize` 不再「冻结」余额，只记「在途敞口」：`reserved_balance += 预估`，放行条件
     `balance + credit_limit - reserved >= 预估`（可用信用）。
  3. `settle` 无条件按实际金额扣费 `balance -= actual`（DB 约束 `balance >= -credit_limit` 触底熔断），
     同时释放敞口 `reserved -= 预估`；**删除「calculated > 预估 → dead」的金额不变量**。
  4. 预估更贴近真实：输入敞口用**字符数**（`extractRequestChars`，token ≤ 字符数）而非字节数；
     （2026-08 起 `extractRequestChars` 已被 CJK 感知的 `estimateInputTokens` 取代，见下「token 估算单一真相」。）
     输出敞口 `min(max_tokens×n, GATEWAY_OUTPUT_EXPOSURE_CAP=32768)`。
  5. admin-api `PATCH /users/:id` 支持 `creditLimit`；`userProfileColumns.availableBalance` 改为
     `balance + credit_limit - reserved`。
- **涉及文件**：
  - `packages/db/src/schema/users.ts` + `migrations/0016_*.sql`（加 credit_limit、删 balance≥0 与 reserved≤balance 约束、加 balance≥-credit_limit）。
  - `packages/ledger/src/{billing-flow,settle,billing-processor,reconcile,ledger,types}.ts`。
  - `apps/gateway/src/services/pipeline/llm-pipeline.ts`、`packages/core/src/env.ts`（加 `GATEWAY_OUTPUT_EXPOSURE_CAP`）。
  - `apps/admin-api/src/{routes/users.ts,services/users.ts}`。
- **测试（TDD）**：
  - `packages/ledger/src/__tests__/billing-flow.test.ts` 新增「credit_limit 透支 / 实际超预估正常扣费 / 结算可让 balance 变负」3 用例；
  - `packages/ledger/src/__tests__/ledger.test.ts` 改「负向调账受 credit_limit 约束」。
  - `apps/gateway/src/routes/__tests__/chat-fallback-pricing.test.ts` 输入上界改为字符数口径。
- **实测效果（真实 MiniMax-M3）**：06 单笔预留从 ¥0.0002898 → **¥0.0000861**（降 ~3.4×），实际扣费 ¥0.00023226
  正常结算、reserved 归 0；08 并发三场景全部 settled/released、无透支无重复扣费无冻结。

---

## 每日花费上限（防羊毛党「细水长流」的总量闸门）

- **为什么加**：RPM/TPM 只挡「频率」，挡不住「细水长流」——60 RPM × 24h = 每天 86400 个请求。真正的总量闸门是「每日花费上限」。
- **实现**：`users.daily_spend_limit`（numeric，NULL=不限）。`authorize` 在事务内检查：
  `当日已结算消费（abs(consume)）+ 当日未终结在途敞口 + 本次预估 ≤ daily_spend_limit`，超限抛
  `DailySpendLimitExceededError` → gateway 映射 402 `daily_spend_limit_exceeded`。
- **关键坑（已修）**：`transactions.amount` 对 consume 是**负数**，求和必须 `abs()`，否则 projected 被拉成负数、
  检查形同虚设（单测 + E2E 实测暴露并修复）。
- **涉及**：`packages/db/src/schema/users.ts` + `migrations/0017_*.sql`、`packages/ledger/src/billing-flow.ts`、
  `apps/gateway/src/services/pipeline/llm-pipeline.ts`、`apps/admin-api/{routes/users.ts,services/users.ts}`。
- **配置**：管理员 `PATCH /api/admin/users/:id {dailySpendLimit: N | null}`。
- **测试**：`billing-flow.test.ts` 新增 2 用例（敞口驱动拦截 + 已结算消费 abs 计入拦截）。
- **E2E**：设 `dailySpendLimit=0` 后请求返回 402 `daily_spend_limit_exceeded`（实测通过）。

### Key 级每日花费上限（团队团员单 Key 封顶）

- **为什么加**：一个用户（团队）可挂多把 Key（团员）。用户级上限封「团队总量」，但拦不住「某个团员刷爆」；
  需要按 Key 单独设「单日最多消费」。
- **实现**：`api_keys.daily_spend_limit`（numeric，NULL=不限）；`billing_requests.api_key_id` 记录发起凭证。
  `authorize` 在用户级检查后，再按 `apiKeyId` 检查：`当日该 Key 已结算消费（usage_logs.amount）+ 当日该 Key 在途敞口 + 本次预估 ≤ daily_spend_limit`。
  超限抛 `DailySpendLimitExceededError(scope='key', apiKeyId)` → gateway 402 `daily_spend_limit_exceeded`（消息带「该 Key（#id）」）。
- **语义**：用户级与 Key 级**独立双闸门**，两者都设时都要满足；未带 Key 的 JWT 请求只受用户级约束。
- **涉及**：`packages/db/src/schema/{api-keys,billing-requests}.ts` + `migrations/0018_*.sql`、
  `packages/ledger/src/{types,billing-flow}.ts`、`apps/gateway/src/services/pipeline/llm-pipeline.ts`、
  `apps/admin-api/src/routes/keys.ts`、admin 前端 `rate-limits`（Key Tab 新增「每日花费上限」列 + 编辑）。
- **配置**：管理员 `PATCH /api/admin/keys/:id {dailySpendLimit: N | null}`。
- **测试**：`billing-flow.test.ts` 新增 4 用例（在途敞口拦截 + scope=key、已结算按 Key 统计拦截、
  NULL=不限、用户/Key 双闸门独立）。
- **E2E**：设 Key `dailySpendLimit=0` → 402 消息含「该 Key（#1921）」；恢复 null → 200（实测通过，脚本 `13-key-daily-spend-limit.mts`）。

### C 端自助：用户可编辑自己 Key 的限流（RPM / TPM / 每日花费上限）

- **为什么**：Key 级限流本质是「团队负责人管团员」，是自助能力而非管理员专属。管理员后台保留兜底覆盖即可。
- **实现**：`apps/client-api/src/routes/keys.ts` 的 `GET /api/keys` 列表回显 + `PATCH /api/keys/:id` + `POST /api/keys`
  均支持 `dailySpendLimit`（rpm/tpm 后端本就支持）；`PATCH` 已强制 `user_id = session.userId`，无越权风险。
  C 端 keys 页编辑弹窗复用共享 `NumberField` 组件，新增 RPM / TPM / 每日花费上限 三个输入（留空=不限），
  表格新增对应三列。
- **E2E**：C 端登录 → 建 Key → `PATCH /api/keys/:id {dailySpendLimit:0}` → gateway 402「该 Key（#1922）」实测通过。

---

## token 估算单一真相（CJK 感知，取代 chars/3.5 与 extractRequestChars）

- **为什么**：旧估算 `ceil(字符数/3.5)` 对中文低估约 3.5×（TPM 预占不足、限流可绕过）；且 TPM 预占
  （chars/3.5）与预扣上界（字符数）口径自相矛盾；媒体 part 计 0、reasoning/多轮 tool_calls/多选
  choices 漏计；`charPerToken=3.5` 在 config 与 usage-estimator 两处硬编码。
- **改法（单一真相）**：`packages/ai/src/usage/token-estimate.ts` 收敛为唯一权威实现——
  `estimateTextTokens`（CJK 1 token/字、拉丁/数字连续段 1 token/段、其他非空白 1 token/个，code point 遍历）、
  `estimateInputTokens`（messages content + 历史 tool_calls + tools 定义体 + embeddings input + 媒体非零下限 85）、
  `estimateOutputTokens`（全量 choices：content/reasoning/tool_calls/text）、`estimateUsage`（estimated=true，非计费）。
  TPM 预占、预扣、用户取消结算统一引用 `estimateInputTokens`；删除 `estimateTokens`/`extractRequestChars`/
  `extractResponseChars` 与 `estimate.charPerToken` 配置。
- **涉及**：`packages/ai/src/usage/{normalize,token-estimate}.ts`、`packages/ai/src/{index,config,create-ai}.ts`、
  `apps/gateway/src/services/pipeline/{llm-pipeline,usage-estimator}.ts`、docs/ai-package.md。
- **测试（TDD）**：`packages/ai/test/unit/token-estimate.test.ts` 新增 21 用例（中文/CJK/媒体/reasoning/多轮
  tool_calls/n>1/数组 content/code point）；`normalize.test.ts` 删旧估算用例；gateway usage-estimator.test.ts、
  chat-fallback-pricing.test.ts 同步改 estimateInputTokens 口径。

---

## 未改动（验证为正确，无需修复）

- 资金账本原子性：`calcAmount` decimal 全精度、`authorize` 原子条件更新、`settleClaim`——并发不透支、不重复扣费（08 实测确认）。
- 首登赠送/充值码幂等、SSRF 防护、上游凭据 AES-256-GCM、管理面/用户面双 JWT 隔离、人工复核链路（09）。
