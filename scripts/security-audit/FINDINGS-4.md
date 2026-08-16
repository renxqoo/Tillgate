# 第四轮逐接口审计 · 缺陷记录与修复（FINDINGS-4）—— 全部当日修复

> 审查日期：2026-08-15（第四轮，逐接口）。方法：先盘点**全部 74 个接口**
> （[`ENDPOINTS.md`](./ENDPOINTS.md)：gateway 6 + admin-api ~40 + client-api ~25 + 内部 3），
> 再三条线并行：① 实弹矩阵脚本 **23/24/25**（无认证/错面 cookie/横向越权/非法输入逐接口打）；
> ② 三路深审（client-api / admin-api / gateway+内部面，逐文件逐接口）；③ 候选项逐一用
> 自造干净数据验证。修复后全量回归：`pnpm test --force` 14/14 包、typecheck 17/17、
> lint 17/17、脚本 23/24/25 全绿 + 18/22 抽检绿。
>
> 结论：**无 P0/P1 资损或越权**（三路深审的正面结论见文末）；实弹复现 2 项（W1/W2）+
> 结构性缺陷族 4 组（A/C/G 共 20+ 处）全部当日修复。账号 → [ACCOUNTS-4.md](./ACCOUNTS-4.md)。

---

## 一、实弹复现并修复

### W1【P2·纵深防御】POST /api/apps 绑定他人 subscriptionId 无归属校验（脚本 23 M3d 实锤 201）
- keys.ts 创建 Key 有 `assertCanUseSubscription`（403），apps.ts 直接落库 → B 用户可把 App
  绑到 A 的订阅（201）。授权侧 billing-flow 有 owner/成员兜底（402）故无资损，但留下
  「看似绑定成功、调用必 402」脏状态，且随受害者 renew/change 被批量改绑长期滞留。
- **修复（组件化下沉）**：守卫唯一实现抽到 `apps/client-api/src/services/subscription-guard.ts`，
  keys.ts 与 apps.ts 共用（同语义同错误码 SUBSCRIPTION_FORBIDDEN/SUBSCRIPTION_NOT_FOUND）。
- **测试**：`apps.subscription-guard.red.test.ts`（B 绑 A 订阅 403 且零残留 + owner 本人 201 对照）。

### W2【P1·错误语义（系统性）】坏 JSON 请求体 → 500（所有 jsonBody 路由）
- hono `validator('json')` 解析失败抛 `HTTPException(400,'Malformed JSON…')`，errorHandler
  只认 HttpError → 全部按未处理异常 500。脚本 23/24 实锤（client/admin 两面 × 全部 POST 路由）。
- **修复（边界层单点翻译）**：`packages/http/src/errors.ts` 识别 HTTPException(400, …JSON…)
  与 SyntaxError → 400 `INVALID_JSON`。
- **测试**：`packages/http/src/__tests__/bad-json.test.ts`（2 用例，含 VALIDATION_ERROR 不回归）。

## 二、结构性缺陷族（一次变更根治一族）

### F1【根治一族 500】PG 约束/值错误 → 4xx 边界翻译（`packages/http/src/errors.ts`）
沿 drizzle cause 链找 5 位 SQLSTATE，映射：23505→409 `CONFLICT`、23503→400 `INVALID_REFERENCE`、
23514→400 `CONSTRAINT_VIOLATION`、22001→400 `VALUE_TOO_LONG`、22P02→400 `INVALID_VALUE`、
22003→400 `VALUE_OUT_OF_RANGE`；node 内部码（ENOENT 等）不误吞仍 500。
**一个翻译点根治**（已验证）：A3 creditLimit 下调撞 `users_balance_credit_floor_ck`、
A4 providers/models/rate-cards 重名 23505、A5 channels.providerId 与 models 绑渠道 FK 23503、
A6 超长串撞 varchar 22001、A1/A2/C2 numeric 溢出 22003/22P02 的全部「未预检漏网」。
**测试**：`pg-error-translation.test.ts` 9 用例。

### F2【预校验硬化】zod 数值/长度/枚举域全量收紧（`MONEY_MAX` 下沉 http 包）
- `packages/http` 导出 `MONEY_MAX=1e9`（原 admin users.ts 本地一份 → 单一真相，redeem 改引）。
- admin：models 价格 `.finite().max(MONEY_MAX)` + contextLength `.finite().max(2e9)` +
  externalName/realModel max；model-catalog 导入价格同款；channel-funds 金额上限；
  users creditLimit/dailySpendLimit 上限 + 搜索 q≤128；channels name/apiKey/baseUrlOverride 长度、
  weight/priority `int 0..1e6`、status 枚举 0..4、upstreamThreshold 上限；providers
  name/baseUrl/protocol/status 域。
- client：keys rpm/tpm/dailySpendLimit 上限；orgs 成员 dailySpendLimit/monthlyQuota 上限；
  apps scope.models `≤100 条 × ≤64 字符`（C5：原可落 24MB jsonb 行）。
- **测试**：`models.numeric-domain.red.test.ts`（'1e999'/1e21/1e30 → 400）、
  `keys.numeric-limit.red.test.ts`（1e21 → 400）。

### F3【业务逻辑】C3 购买传加油包 planId → 未映射错误 → 500
ledger 抛 `not_a_pack`，client mapError 无分支裸抛。修复：mapError 补
`not_a_pack → 400 NOT_A_PACK`、`invalid_amount → 400`。
**测试**：`subscriptions.pack-plan.red.test.ts`（400 且零扣款零订阅）。

### F4【业务逻辑·P2 高】C4 个人订阅自然到期后永久无法再购买（死锁）
链路：无任务翻转过期行 → 唯一部分索引（status=0）仍占位 → 新购买撞 23505 →
`already_subscribed` 409；而 `/me/subscription` 因 endAt>now 返回 null（拿不到 id 去 renew）
→ 「显示无订阅但购买永 409」。任何个人套餐用户到期必现。
- **修复（治本）**：购买事务内**懒翻转**「status=0 且 end_at≤now 且 org_id IS NULL」行为
  status=1（与 renew 的「旧订阅转到期」同语义；不动 org 行——renew 依赖 status=0 可续期）；
  迁移 **0035** 一次性回填存量 16 行。
- **测试**：`subscription-expired-repurchase.red.test.ts`（过期后可再购 + 无残留 status=0 过期行）。

### F5【并发/结构】A8 三处
- `channels.name` 无 DB 唯一（导入查重是先查后插非原子，并发双渠道）→ 迁移 0035
  `channels_name_uq`（存量查重：0 重复）。
- **model_channels 复合 PK 声明从未落库**（快照亦未跟踪此表——drizzle 迁移域外漂移）：
  同一映射可重复绑同一渠道、且无法作 ON CONFLICT 仲裁者 → 迁移 0037 补建 PK（存量 0 重复）。
- 目录导入 `ensureBound` 先查后插 → 改 `onConflictDoNothing` 原子幂等。

### F6【薅羊毛/资源】C6 每用户凭证配额
POST /api/keys、POST /api/apps 原可无限刷行（audit 同步膨胀）→ 每用户有效 Key/App ≤100，
超出 409 `KEY_LIMIT_REACHED` / `APP_LIMIT_REACHED`。

### F7【小项簇】A9
plans PATCH 更新 0 行返回 undefined → 补 404；`/api/admin/logs` 死参数 `model` 删除
（request_logs 无 model 列，前端过滤静默失效——删除优于兼容）；渠道导入行级错误不再
回传底层异常原文（可含 PG 约束名/驱动细节），仅回分类语义。

## 三、gateway / 内部面（G 族，全部 P2）

| # | 缺陷 | 修复 |
|---|------|------|
| G4 | 非流式上游读体默认 256KB → 合法大输出被误判 `invalid_response` → 换渠全灭 503 + 预扣冻 uncertain（用户可自行制造资金冻结/复核负担） | `create-ai.ts` readBody `maxBytes: 8MB`（2 处调用点） |
| G3 | fallback 模型不参与 RPM/TPM 限流维度——主渠道故障窗口内 fallback 模型维形同虚设，多用户合流可击穿其上游配额 | 候选循环派发 fallback 前，对其 `model:{id}` RPM 原子判定 + `user:{id}:model:{id}`/`model:{id}` TPM 预占（镜像渠道级限流语义：超限→换候选；requestId 去重不双计） |
| G1 | trace-receiver `/v1/traces` 无请求体上限（`c.req.json()` 整读任意体积 → OOM/存储耗尽） | `bodyLimit 8MB`（OTLP JSON 批次远小于此） |
| G2 | worker `:8792 /health` 深度报告（结算积压全景 + lastError 原文）无鉴权全网卡监听 | `/health` 须 `x-health-token` == `WORKER_HEALTH_TOKEN`（未配则 403）；livez/readyz 保持开放（编排器探针语义，无敏感字段） |

## 四、验证为可靠（防误修，三路深审正面结论浓缩）

- **鉴权覆盖 fail-closed**：三面新增路由默认进受保护子应用；`/v1/*` 精确路径无绕过
  （子路径/尾斜杠/大小写均 404）；双平面 cookie 物理隔离（iss+type 双验）。
- **横向越权**：keys/apps/orgs/subscriptions 全链路 `userId` 归属过滤；org 管理 requireOwner；
  owner 不能删自己；邀请 accept 事务内 FOR UPDATE 复检席位 + 一次性 + 重入守卫。
- **资金**：admin adjust/gift 幂等 + 审计 + 信用下限原子守卫；订阅管理端与用户自助同源
  （ledger 单实现）；billing-operations CAS + 状态门，settled 不可能再进 dead（无双退款）；
  redeem 单笔原子抢占；并发购买恰 1 单。
- **信息投影**：users/keys/channels 响应均为显式列白名单（无 passwordHash/keyHash/密文）；
  VoucherStorage key 正则白名单（穿越探针 6 发全拒）。
- **注入**：orderBy/分页/搜索全参数化或枚举白名单；SSE 帧逐帧 JSON 重写无拼接注入面。
- **oauth/JWT**：grant 白名单、常量时间比较无存在性 oracle、App 禁用与用户禁用均阻断换
  token（实测 401「账户已被禁用」）、HS256 钉死、载荷 zod 再验。

## 五、挂账（本轮不修，原因）

| 项 | 原因 |
|---|---|
| login/logout 挂公开区无 CSRF（C7） | logout 无状态破坏、login CSRF 需攻击者自己的口令——骚扰级，修复价值低 |
| org 邀请无数量限流、无客户端撤销路由（C6 余项） | 席位在 accept 时硬校验，邀请行膨胀有限；撤销路由属产品功能非缺陷 |
| admin `/users/:id/transactions` from/to 未实现 | 功能缺口（参数被忽略），非安全缺陷；与用户面能力对齐属产品迭代 |
| G3 fallback 的 user×model TPM 维在派发时点预留 | 窗口语义（主渠道失败后才预留）与渠道级限流一致；跨候选并发残余窗口极窄 |
| `WORKER_HEALTH_TOKEN` 未配则 /health 403 | 运维须知项（.env 模板应补默认值）；livez/readyz 不受影响 |
| 上游错误信息透传 / XFF 首跳 / usage 金额 Number() 等 | 沿用第二、三轮挂账清单（FINDINGS-2/3） |

## 六、回归与记录

| 项 | 结果 |
|---|---|
| 红测（本轮新增 6 文件） | W1/W2/C3/C4 先红后绿；A1/C2 由 F1 翻译层直接转绿（留作回归） |
| `pnpm test --force` | 14/14 包全绿（含修复前失败的 model-catalog 42P10——根因即 F5 的 PK 缺失） |
| `pnpm typecheck` / `pnpm lint` | 17/17 / 17/17 |
| 脚本 23 / 24 / 25 | 全绿（23 首轮 9 红 → 修复后 0 红） |
| 脚本 18 / 22 抽检 | 全绿（ledger 购买路径改动不回归） |
| 迁移 | 0035（回填 16 行 + channels_name_uq）、0037（model_channels PK）均已应用 |
