# AI Gateway 安全审计 · 回归测试集（7 处缺陷已全部修复）

针对**已运行的真实服务**（gateway `:8787` / admin-api `:8790` / client-api `:8791` / worker `:8792`，
真实 PostgreSQL + Redis）发真实 HTTP 请求。审计共发现 **7 个缺陷 + 2 项正确性验证**，现已**全部按 TDD 修复**：
先补强/新增单元测试 → 报红（RED）→ 改业务代码 → 转绿（GREEN）→ 用本目录脚本做 E2E 回归（全部 exit 0）。

> ✅ **修复状态**：01/02/03/04/06/07/08 已修复并通过回归；05/09 为「正确性验证」非缺陷。
> 🔧 **修复记录（根因 → 改法 → 涉及文件 → 测试）** → [`FIXES.md`](./FIXES.md)
> 📋 **测试账号（管理员 + 密码 + 用户/Key/App 明细）** → [`ACCOUNTS.md`](./ACCOUNTS.md)

---

## 一、运行（回归验证）

```bash
# 前提：4 个服务已运行（pnpm dev）
pnpm tsx scripts/security-audit/01-login-timing-user-enumeration.mts   # ✅ exit 0
pnpm tsx scripts/security-audit/02-login-lockout-dos.mts               # ✅ exit 0
pnpm tsx scripts/security-audit/03-csrf-missing-origin-check.mts       # ✅ exit 0
pnpm tsx scripts/security-audit/04-jwt-rate-limit-bypass.mts           # ✅ exit 0
pnpm tsx scripts/security-audit/05-concurrency-smoke.mts               # ✅ exit 0
pnpm tsx scripts/security-audit/06-billing-settlement-minimax.mts      # ✅ exit 0（真实 MiniMax-M3）
pnpm tsx scripts/security-audit/07-auth-failure-no-rate-limit.mts      # ✅ exit 0
pnpm tsx scripts/security-audit/08-concurrent-billing-minimax.mts      # ✅ exit 0（真实 MiniMax-M3）
pnpm tsx scripts/security-audit/09-billing-review-flow.mts             # ✅ exit 0
```

> 按指示：**所有脚本都不清理自建账号与测试流水**（账号/Key/App/请求日志/审计日志/账单全部保留）。
> 真实模型只用 **MiniMax-M3**；04/05/07 不会命中上游；06/08 真实调用 MiniMax-M3（≈¥0.0002/次）。
> 修复后 06/08 的 200 订单全部 `settled`（精确计费），上游 429 全部 `released`（不冻结预留）。

---

## 二、结论速览（7 缺陷 + 2 验证，均已完成）

| # | 脚本 | 缺陷 | 严重度 | 状态 |
|---|------|------|--------|------|
| 06 | `06-billing-settlement-minimax.mts` | 字节数当 token 上界，成功订单被误判 `dead` 不扣费 | 高（资损） | ✅ 已修复 |
| 08 | `08-concurrent-billing-minimax.mts` | 上游 429 错误码 `rate_limit_error` 未归一 → 误冻结 `uncertain` | 高（资损） | ✅ 已修复 |
| 01 | `01-login-timing-user-enumeration.mts` | 登录时序侧信道，用户名/邮箱可枚举 | 高 | ✅ 已修复 |
| 02 | `02-login-lockout-dos.mts` | identifier-only 锁定 → 任意账号（含管理员）可被锁死 | 高 | ✅ 已修复 |
| 07 | `07-auth-failure-no-rate-limit.mts` | 鉴权失败路径无来源级限流，可无限刷 401 | 中高 | ✅ 已修复 |
| 04 | `04-jwt-rate-limit-bypass.mts` | JWT 路径绕过每用户 RPM 限流 | 中高 | ✅ 已修复 |
| 03 | `03-csrf-missing-origin-check.mts` | 状态变更接口无 Origin/Referer 服务端校验 | 中 | ✅ 已修复 |
| 05 | `05-concurrency-smoke.mts` | 并发冒烟 + 容量参考 | 观测 | ✅ 通过 |
| 09 | `09-billing-review-flow.mts` | 计费异常人工复核链路 | 观测 | ✅ 通过 |

---

## 三、问题详解（根因，已全部修复）

### A. 计费 / 资损（最严重，直接影响收入）

#### 06 · 真实 MiniMax 订单被判死、用户不被扣费（白嫖）
- **根因**：`apps/gateway/src/services/pipeline/llm-pipeline.ts` 的 `inputTokenUpperBound()` 用
  `Buffer.byteLength(JSON.stringify(body))` 作为输入 token 上界；`packages/ledger/src/billing-flow.ts`
  的 `validateReceipt` 把该上界当**硬上限**（`inputTokens > 上界 → usage_exceeds_authorization → dead`）。
- **实测**：MiniMax-M3 对「只回复两个字：你好」上报 `prompt_tokens=181`（含 cached 128），字节上界仅 ≈106，
  `181 > 106` → `billing_requests` 落 `dead|usage_exceeds_authorization`。
- **后果**：上游成本已产生、用户**不被扣费**、预留永久冻结、订单卡死需人工复核。本单实际应扣 ¥0.00023226
  **低于**预留 ¥0.0002898，本应正常结算——判死纯属「字节数≠token 数」的估算误伤。

#### 08 · 并发下上游 429 被误冻结为 uncertain（错误码命名不匹配）
- **根因**：`packages/ai/src/errors/classify.ts` 对 429 返回 `code: bodyCode ?? 'rate_limited'`，把 MiniMax
  body 里的 `code='rate_limit_error'` **原样透出**；而 gateway 的 `upstreamCharge()` / `isChannelSwitchable()`
  只认 `'rate_limited'`。
- **实测**：1 用户 ×20 Key ×20 并发时，MiniMax 突发 429，10 笔落 `uncertain|failure_code=rate_limit_error`，
  各冻结 ¥0.0002898，**既不扣费也不退款**、也不做渠道切换。
- **后果**：失败请求的预留被永久冻结，用户可用余额被无谓占用。

> 08 同时验证了**资金原子性正确**：60 个并发请求**无透支、无重复扣费**（`authorize` 的
> `balance - reserved >= amount` 原子条件更新可靠）。

#### 09 · 人工复核链路（✅ 验证通过，非 bug）
- `GET /billing-operations?status=dead|uncertain`、`POST .../retry`、`POST .../resolve` 均正常。
- `retry`（对 dead）→ 实际结算 ¥0.00023226 并精确释放本单预留；`resolve confirmed_no_charge`（对 uncertain）→ 释放预留退款。
- 说明：**bug 在「自动结算」环节（06/08），不在复核接口**；复核接口能正确清掉这些异常单，但代价是 118+ 条需人工逐条点。

### B. 登录安全

#### 01 · 登录时序侧信道 → 用户名/邮箱可枚举
`apps/client-api/src/services/auth.ts` 与 `apps/admin-api/src/routes/admin-auth.ts`：
`passwordOk = user ? await verifyPassword(...) : false` —— 用户不存在时**不执行 scrypt**；`identity/password.ts`
对空 hash 直接 `return false`。结果「存在账号」≈42ms、「不存在」≈3ms，用响应时长即可枚举真实账号/管理员邮箱。

#### 02 · 登录锁定 DoS（任意账号含管理员可被锁死）
`packages/identity/src/login-throttle.ts` 的 identifier-only 维度仅按 username/email 锁 10 分钟、**不绑 IP**。
任意匿名者 5 次错误密码即可锁死目标（用户面按 username、管理面按 email），每 10 分钟可续锁 → 永久拒绝服务。

### C. 鉴权 / 限流

#### 07 · 鉴权失败路径无 global/IP 限流（可无限刷 401）
`apps/gateway/src/app.ts` 中间件顺序 `requestLog → auth → 路由`，RPM/TPM 限流在路由内才执行 → 鉴权失败
（无效 Key）走不到限流器；`brute-force-guard` 只按 keyHash 计数（阈值 5），换随机 Key 即绕过。
实测 30 个不同随机 Key 全 401、0 个 429，且每条 fire-and-forget 写 `request_logs` + 累积 Redis `auth:fails:*`。

#### 04 · JWT（App）路径绕过每用户 RPM 限流
`apps/gateway/src/services/auth/auth-service.ts` `authenticateJwt` 返回 `userRpmLimit: null`，管线退回
`DEFAULT_USER_RPM=60`。实测管理员 `PATCH /users/:id {rpmLimit:1}` 后：静态 Key 第 2 次 429，但同用户自建 App
换 JWT 第 2 次仍放行（402）——每用户限流被绕过。

### D. CSRF / 浏览器安全

#### 03 · 状态变更接口缺 Origin/Referer 服务端校验
`apps/client-api/src/routes/*` 只依赖 `ag_session` Cookie（SameSite=Lax），无 CSRF Token、无 Origin 校验。
实测带 `Origin: https://evil.example` 的 `POST /api/keys` 仍返回 201 并真实创建 Key；改密码接口同样照常处理请求。

### E. 并发 / 容量

#### 05 · 并发冒烟（✅ 通过，容量参考）
并发 50 打 `/v1/models` 600 次、无效 Key 401 路径 300 次：**0 个 5xx**，压后 `/readyz` 健康。
单实例吞吐（开发库）：`/v1/models` ≈4600 req/s、鉴权 401 路径 ≈2600 req/s。
真实对话接口吞吐受上游 MiniMax 延迟与计费授权支配，需按生产流量另行压测。

---

## 四、已核实的「正确」项（代码审计 + 实测确认，非缺陷）

- **资金账本核心**：`calcAmount` decimal 全精度、`authorize` 原子信用检查、`settleClaim` 幂等结算——
  并发不透支、单请求不重复扣费（08 实测确认）。
- **首登赠送防刷**：`grantSignupGift` 按 `balance=0 且无流水` + `fund_operations` 自然键幂等，无法重放；
  **充值码** 160-bit 熵 + 兑换幂等，无法爆破。
- **注册安全**：当前**无对外自助注册端点**（一期「管理员开通」），不存在公开注册/批量刷号入口。
- **SSRF**：`packages/ai/src/transport/http-client.ts` 做了 https-only + 内网/回环 IP 段 + DNS 逐地址校验（防 rebinding）+ 生产 hostname 白名单。
- **上游凭据**：AES-256-GCM 落库、明文不进日志/缓存（model-router 只存密文）、密钥强度 env 校验。
- **管理面隔离**：admin-api/client-api 双 JWT 密钥 + 双 cookie + issuer/type 双重校验，物理隔离成立。

---

## 五、修复记录（详见 `FIXES.md`）

7 处缺陷已全部按 TDD 修复，并**重构计费为信用模型**（先 RED 测试 → 改码 → GREEN）。核心改动一句话：

1. **06 + 08（计费资损）** —— `validateReceipt` 移除「字节数当 token 硬上限」，资损防线改为结算阶段的
   **金额信用判定**；`ai/classify` 把 429 归一为 `rate_limited`（不再透传供应商 body code）。
2. **01/02（登录）** —— `verifyPassword` 对不存在用户跑等量 scrypt（哑哈希）；登录限流改为「单源硬锁 + 正确密码豁免」，
   删除 identifier-only 硬锁（根除账号锁定 DoS）。
3. **07（鉴权失败限流）** —— 新增来源级 `AuthFailureGuard`（正确凭证豁免），无效 Key 不再写 per-key 计数、
   429 不写 request_logs。
4. **04（限流绕过）** —— JWT 鉴权与静态 Key 对称，从 `users` 表加载 `rpm_limit/tpm_limit`（60s 缓存）。
5. **03（CSRF）** —— 新增 `packages/http/csrf.ts`，client-api / admin-api 状态变更接口校验 Origin/Referer。
6. **计费架构：预授权冻结 → 信用模型（事后扣 + 透支上限兜底）** —— 详见 FIXES.md。
   删除「冻结峰值金额」，改为 `credit_limit` 透支上限 + 在途敞口熔断 + 结算按实际金额扣费；
   单笔预留从 ¥0.0002898 降至 ¥0.0000861（降 ~3.4×），根治「余额 10+ 也被预留挤空而 402 中断」。
