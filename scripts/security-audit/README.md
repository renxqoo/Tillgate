# AI Gateway 安全审计 · 回归测试集（三轮缺陷均已修复）

> ✅ **第二轮审查（2026-08-15）**：全量复审发现 6 处缺陷（R1-R6），**同日全部修复**（TDD 红转绿，
> （R1 预占泄漏 / R2 零价套餐资损 / R3 订阅生命周期 / R4 渠道预算并发 / R5 认证三缺陷 /
> R6 is_free 口径分裂）+ 约 20 项静态发现，脚本编号 **18~21**，红测 4 文件 9 用例。
> 明细 → [`FINDINGS-2.md`](./FINDINGS-2.md) · 账号 → [`ACCOUNTS-2.md`](./ACCOUNTS-2.md) ·
> 总报告 → `docs/reviews/2026-08-15-security-money-concurrency-review.md`。
>
> ✅ **第三轮攻击审查（2026-08-15）**：交易/金额/幂等/越权/DoS 实弹攻击。实弹复现 4 项
> （**T1 幂等键命名空间投毒→任意新用户登录永久 500** / T1b 超长键 500 / T3 席位购买
> 幂等失效+孤儿 org / T4 1MB client_id 落 Redis）+ 静态实锤修复 8 项（T2 幂等指纹未绑
> 操作者、T5 API 无 bodyLimit、T6×6 批量加固），同日全部修复。脚本 **22**（修复前 RED →
> 修复后 GREEN ×2）。明细 → [`FINDINGS-3.md`](./FINDINGS-3.md) · 账号 → [`ACCOUNTS-3.md`](./ACCOUNTS-3.md)。
>
> ✅ **第四轮逐接口审计（2026-08-15）**：先盘点全部 **74 个接口**
> （[`ENDPOINTS.md`](./ENDPOINTS.md)），实弹矩阵脚本 **23/24/25** 逐接口打
> （无认证/错面/横向越权/非法输入），三路深审逐文件复核。实锤 W1（apps 绑他人订阅）、
> W2（坏 JSON → 500，系统性）+ 结构性缺陷族 4 组（PG 约束错误裸奔 500 一族、zod 数值域
> 缺失一族、**C4 过期订阅永久无法再购死锁**、A8 并发/结构三处：channels 名唯一 +
> model_channels PK 从未落库）+ G1-G4（receiver 体积闸、worker 健康口门禁、fallback
> 限流盲区、大响应误判冻结），当日全部修复，14/14 包全量回归绿。
> 明细 → [`FINDINGS-4.md`](./FINDINGS-4.md) · 账号 → [`ACCOUNTS-4.md`](./ACCOUNTS-4.md)。
>
> ✅ **第五轮挂账清偿（2026-08-15）**：前三轮「明确未修复」清单中可代码级治本的全部事项
> 六批次修完——资金 DB 约束族（迁移 0038：transactions 余额链恒等式 CHECK + 1359 行存量
> 整链重算、usage_logs 双 CHECK、模型非负价、rate_card 全局行唯一）、上游错误出站脱敏、
> 金额类型/文档对齐、死代码一次删净（jti_blacklist/bad_debt/candidates_tried 列迁移 0039/
> 白名单/formatYuan/MeInfo.role）、功能补齐（登录审计双面、邀请撤销、admin 交易过滤、
> Redis 键名单一来源）、HS256 生产 32 字节 + DEV_FAKE_ME 生产门控。14/14 包全量回归绿。
> 明细 → [`FINDINGS-5.md`](./FINDINGS-5.md)。剩余 6 项架构决策待用户拍板（见 FINDINGS-5 文末）。
>
> ✅ **第六轮架构清偿（2026-08-15）**：挂账 6 项中的 5 项按推荐方案实施——
> **XFF 信任模型**（TRUSTED_PROXY_HOPS 右数第 N 跳，伪造首段结构性丢弃）、
> **CSRF fail-closed**（INTERNAL_API_TOKEN BFF 令牌，双缺失头不再裸放行）、
> **免费模型日限额**（500/天默认，429 业务码）、**加密轮换重设计**（enc:v1/v2 信封 +
> 双 key 窗 + 事务化脚本）、**request_logs 月分区**（迁移 0040 + worker 30 天滚动维护）。
> 14/14 包全量回归绿；worker /health 令牌门实测生效。maker-checker 仍挂账（产品设计）。
> 明细 → [`FINDINGS-6.md`](./FINDINGS-6.md)。
>
> ✅ **第七轮收尾清偿（2026-08-15）**：验证债务清偿（脚本 20/21 复跑全绿）；
> 首次 `pnpm audit` → nanoid high 钉版后生产依赖零漏洞（esbuild 仅 dev 工具链，接受）；
> **login/logout CSRF 收口**（公开组挂 csrfProtection，C7 关闭）；前端入口补齐
> （org 邀请撤销 + admin 交易时间筛选）；两个面板补浏览器安全头（CSP/XFO/nosniff）；
> 新增部署检查清单 `docs/deployment-checklist.md` + 分区表 drizzle 漂移警示。
> 14/14 包全量回归绿。剩余 7 项挂账均为产品/运维决策（FINDINGS-7 文末表）。
> 明细 → [`FINDINGS-7.md`](./FINDINGS-7.md)。
>
> ✅ **第八轮功能交付（2026-08-15）**：管理员**邮箱验证码二次登录**（国内习惯方案，替代
> TOTP）——默认关、设置页自助开；个人邮箱 SMTP（QQ/163 授权码）即可用；SMTP 未配置
> fail-closed（503 不降级单密码）；验证码 SHA-256 落 Redis、5 分钟有效、错 5 次作废、
> 60s 限发；登录页两步 UI + 安全设置页。迁移 0041；nodemailer 钉 9.0.5 后 audit 仍零漏洞。
> 明细 → [`FINDINGS-8.md`](./FINDINGS-8.md)。

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
pnpm tsx scripts/security-audit/18-free-plan-self-subscribe.mts        # ✅ exit 0（R2 验收）
pnpm tsx scripts/security-audit/19-oauth-lockout-session-nan.mts       # ✅ exit 0（R5 验收）
pnpm tsx scripts/security-audit/20-boundary-billing-e2e.mts            # ✅ exit 0（临界值扣费 7 场景，S3 需等结算重试退避）
pnpm tsx scripts/security-audit/21-real-models-reconciliation.mts      # ✅ exit 0（真实模型对账：deepseek 20 并发 / MiniMax-M3 / gpt-oss-20b）
pnpm tsx scripts/security-audit/22-idempotency-oauth-attacks.mts       # ✅ exit 0（T1/T1b/T3/T4 验收）
pnpm tsx scripts/security-audit/23-client-api-endpoint-matrix.mts      # ✅ exit 0（用户面接口矩阵）
pnpm tsx scripts/security-audit/24-admin-api-endpoint-matrix.mts       # ✅ exit 0（管理面接口矩阵）
pnpm tsx scripts/security-audit/25-gateway-internal-matrix.mts         # ✅ exit 0（网关/内部面矩阵）
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
