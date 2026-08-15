# 第三轮安全攻击审查 · 缺陷记录与修复（FINDINGS-3）—— T1-T6 已全部修复

> 审查日期：2026-08-15（第三轮，实弹攻击向）。范围：交易与金额处理、幂等性、登录/注册、
> 越权（横向/纵向）、黑客攻击向量（命名空间投毒 / 原型污染 / 算法混淆 / 资源耗尽 DoS）。
> 方法：4 路攻击面专项审查（交易资金 / 认证会话 / 越权与注入 / 资源耗尽）→ 候选项代码级
> 核实 → 实弹脚本复现（[`22-idempotency-oauth-attacks.mts`](./22-idempotency-oauth-attacks.mts)）
> → 当日 TDD 修复 → 全量回归。
>
> 结论：**实弹复现 4 项（T1/T1b/T3/T4，修复前脚本 22 全部 RED）+ 静态实锤修复 8 项
> （T2/T5/T6×6）**。验收口径：脚本 22 两轮 exit 0、脚本 19 复验 exit 0、
> `pnpm test --force` 13 包 exit 0、`pnpm typecheck` 17/17、`pnpm lint` 0 错误。
> 账号留档 → [ACCOUNTS-3.md](./ACCOUNTS-3.md)；前两轮 → [FINDINGS-2.md](./FINDINGS-2.md)。

---

## T1【P0 · 任意新用户永久锁死】幂等键命名空间投毒

- **攻击链（实弹复现）**：`packages/http/src/idempotency.ts` 把 `idempotency-key` 请求头
  **原样**作为 `fund_operations.operationId`（全局主键）使用，无字符集/长度校验——而系统
  自然键（`signup-gift:{userId}` 等）与其共享同一主键空间。攻击者只需余额 ¥1：
  1. userId 自增可推算，锁定一个「已建号未登录」的受害者；2. 带
  `idempotency-key: signup-gift:{受害者id}` 完成一次套餐购买 → 该主键被永久占用；
  3. 受害者首次登录 `grantSignupGift` 插入 `signup-gift:{自己id}` 撞主键 →
  `IdempotencyConflictError` 未被登录路径捕获 → **登录 500，且每次重试都 500（永久锁死）**。
- **实锤数据（保留在库）**：`fund_operations` 中 `signup-gift:9493` / `signup-gift:9495` =
  `subscription.purchase`（攻击者 9494/9496 所购，plan 2759 ¥1，订阅 3725/3726）；
  受害者 9493/9495 余额 0、礼金从未到账、登录必然 500。
- **T1b（附带）**：超长键（>128）直接落 PG → 22001 → 500（应 400）。
- **改法（治本：客户端键与系统命名空间物理隔离）**：客户端键只允许
  `/^[A-Za-z0-9_-]{1,64}$/`——**排除冒号**（系统命名空间分隔符），64 上限同时消灭 T1b；
  未携带时服务端生成 UUID；违规 400 `INVALID_IDEMPOTENCY_KEY`。
- **涉及**：`packages/http/src/idempotency.ts`（重写）、
  `packages/http/src/__tests__/idempotency-key.test.ts`（新增 4 用例）。
- **验证**：脚本 22——投毒购买被 400 拒绝，受害者登录 200 且礼金 ¥1 正常到账（9911/9914）。

## T2【P1 · 跨操作者重放】订阅 change/cancel 幂等指纹未绑定发起者

- **缺陷**：`changeSubscription` / `cancelSubscription` 的幂等指纹只含业务参数
  （subscriptionId/targetPlanId/quantity），不含发起者。用户自助与管理员代办共用键空间时，
  不同 actor 用相同 `operationId` 重放会**指纹匹配成功**，把别人的余额快照
  （balanceBefore/After）原样回放给攻击者——幂等回执变成越权读取通道。
- **改法**：指纹补齐 `userId` / `adminId`（`ledger.ts:877` change、`:1242` cancel），
  跨 actor 重放必为 `idempotency_conflict`（409），绝不回放他人回执。
- **测试**：ledger 既有订阅套件 24 用例不回归（指纹变更不破坏同 actor 重放）。

## T3【P1 · 幂等失效 + 孤儿组织】团队套餐购买 org 创建在账本事务外

- **实弹复现（RED）**：企业用户买席位套餐时，路由先建 `organizations`/`org_members` 再调
  `subscribePlan`。同幂等键重放 = **再建一个 org** + 新 orgId 改变指纹 → 409（幂等性完全
  失效）；余额不足失败 = 留下孤儿 org（可无限刷行）。实测用户 9497 名下两个 org
  （255/256）即重放产物。
- **改法（org 与订阅同生共死）**：`applySubscription` 增加 `ensureOrg` 参数——组织与
  owner 成员在**账本事务内、套餐校验通过之后**创建；`SubscribeResult` 增加 `orgId` 回传；
  购买路由简化为 `ensureOrg: true`（删除事务外预建逻辑）。
- **涉及**：`packages/ledger/src/ledger.ts`、`apps/client-api/src/routes/subscriptions.ts`。
- **验证**：脚本 22 T3——同键重放 `replayed=true` 且 org 数 1→1（9913/9916 各仅 1 个 org）。

## T4【P2 · 资源耗尽】对外端点未设限的输入长度

- **实弹复现（RED）**：`POST /oauth/token` 携带 **1MB client_id** 未被拒绝，进入 Redis
  计数键 `oauth_attempts:{1MB}`（键膨胀 + 内存攻击面）；`/v1/chat/completions` 的
  `model`、`messages`、embeddings `input` 数组均无上限（上游/DB 压力放大器）。
- **改法**：oauth-token 在任何 DB/Redis 访问**之前**校验 `client_id≤64 / client_secret≤256`
  → 400；`model` 收紧为 `z.string().min(1).max(64)` 且禁 NUL；`messages≤1000`；
  embeddings `input` 数组 `≤2048`。
- **涉及**：`apps/gateway/src/routes/oauth-token.ts`、`chat-completions.ts`、`embeddings.ts`。
- **验证**：脚本 22 T4——1MB client_id 400，且 `oauth_attempts:AAA*` 无 Redis 键。

## T5【P2 · DoS】client-api / admin-api 无请求体大小限制

- **缺陷**：JSON body 解析无上限（网关 16MB，两个 API 面无限），大包直接打满内存。
- **改法**：两 app 挂 `hono/body-limit` `maxSize: 32MB`（管理面允许批量导入的大负载）。
- **涉及**：`apps/client-api/src/app.ts`、`apps/admin-api/src/app.ts`。

## T6【批量加固】静态实锤的 8 处小缺陷（每项独立修复）

| # | 缺陷 | 改法 | 涉及 |
|---|------|------|------|
| 1 | 金额输入无上界/可 Infinity：兑换码批量金额、渠道资金调整、模型价格可写 `1e308`/`Infinity` | `MONEY_MAX=1e9` + `.finite()` + 价格 `.min(0).finite()` | admin-api `users.ts`(导出)/`redeem.ts`/`channel-funds.ts`/`models.ts` |
| 2 | JWT 算法未钉死（alg 混淆面） | `jwtVerify` 显式 `algorithms:['HS256']` | `packages/identity/src/session.ts`、`apps/gateway/src/services/auth/jwt.ts` |
| 3 | `JWT_SECRET === ADMIN_JWT_SECRET` 可静默配置（双平面隔离归零） | `loadAdminApiEnv` 启动即抛错 | `packages/core/src/env.ts` |
| 4 | `/api/me` 交易列表泄漏内部 `createdBy`（操作者标识）；api-client 幻影类型双向漂移 | 显式列清单排除 `createdBy`；删除幻影 `TransactionRow.createdBy` | `apps/client-api/src/routes/me.ts`、`packages/api-client/src/types.ts` |
| 5 | redeem 限流 INCR/EXPIRE 两步竞态（可造无 TTL 键） | 改 Lua 原子 `INCR+EXPIRE` | `apps/client-api/src/services/redeem.ts` |
| 6 | org 成员退出后重进：upsert 无状态守卫 | `onConflictDoUpdate` + `setWhere: status=1`（仅退出态可复活） | `apps/client-api/src/routes/orgs.ts` |
| 7 | OpenAI 兼容适配器 param_rules 映射目标键可写 `__proto__`/`constructor`（原型污染） | 映射目标黑名单跳过 | `packages/ai/src/adapters/openai-compatible.ts` |
| 8 | XFF 伪造可绕过登录限流/authfail 计数（第二轮回流项） | nginx 外层 `limit_req`（/v1/ 20r/s burst 40；/oauth/token burst 20） | `docker/nginx/nginx.conf` |

---

## 攻击面审查验证为可靠（防误修，勿「修复」）

- **交易原子性**：所有余额变更均为守卫 CAS（`balance - reserved >= amount` 条件更新 +
  returning 校验），transactions 与余额快照成对落库；重放路径只读回执、绝不二次执行。
- **双平面隔离**：JWT_SECRET / ADMIN_JWT_SECRET 双密钥 + iss + type 三重校验，物理隔离
  （T6-3 后配置错误直接拒绝启动）。
- **注入面**：全量 Drizzle 参数化，无字符串拼接 SQL；无来自客户端输入的原型污染可达路径
  （T6-7 收口后适配器配置面也闭环）。
- **SSRF**：https-only + 内网/回环段 + DNS 逐地址校验 + 生产 hostname 白名单（复核未变）。
- **CORS**：allow-list 且不开 credentials。

## 已知接受 / 挂账项（本轮不修，需产品决策）

| 项 | 现状 | 挂账原因 |
|---|------|----------|
| XFF 首跳信任模型 | 登录限流/authfail 按 XFF 首跳计数，直连可伪造绕过 | nginx limit_req 已做外层缓解；治本需 TRUSTED_PROXY_HOPS 设计（可信代理跳数归一化） |
| CSRF 全 fail-closed | Origin 与 Referer **同时缺失**时放行 | Next.js BFF 服务端调用无 Origin 头，fail-closed 会打断自身；需服务间 token 方案 |
| 订阅存在性 oracle | 访问他人订阅 404/403 语义区分可探测存在性 | 信息价值低，修复牺牲错误语义分级 |
| org 成员邮箱互见 | 成员列表对全体成员展示 email | 产品预期（团队协作），如需隐私再收敛 |
| `jti_blacklist` 只读死代码 | 无写入方 | 随会话吊销锚点（session_invalid_before）方案一并清理 |
| `DEV_FAKE_ME` 无 NODE_ENV 门控 | env 变量进生产即渲染假身份壳 | 需连 admin/client 两个 Next.js 一并门控，避免半吊子改动 |
| docs 信用模型漂移 | requirements/data-model 仍写旧不变量 | 文档工程，随下轮文档专项修 |
| request_logs 分区 / usage summary 金额类型 | 未实施 / Number() 化金额 | 容量工程与 API 契约变更，非安全缺陷 |

## 回归与记录

| 项 | 结果 |
|---|---|
| 脚本 22（修复前） | RED exit 1：T1 受害者登录 500 / T1b 500 / T3 双 org+409 / T4 200 |
| 脚本 22（修复后，两轮） | GREEN exit 0 ×2 |
| 脚本 19 复验（R5 不回归） | exit 0 |
| `pnpm test --force` | 13 包全绿 exit 0 |
| `pnpm typecheck` / `pnpm lint` | 17/17 / 0 错误 |

> 测试数据全部保留未清理，账号清单见 [ACCOUNTS-3.md](./ACCOUNTS-3.md)。
