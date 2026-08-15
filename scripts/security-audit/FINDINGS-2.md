# 第二轮安全/资金审查 · 缺陷记录（FINDINGS-2）—— R1-R6 已全部修复

> 审查日期：2026-08-15。范围：架构、设计、安全（登录/注册/会话/CSRF/XSS）、付费与金额、
> 并发竞态、薅羊毛向量。方法：5 路静态审查 + 全部缺陷**逐个人工验证**（代码级 + 红测复现 +
> 真实服务实时复现）。**本轮只找 bug、写红测、记录，不改任何业务代码。**
>
> 基线：`pnpm test` 全绿（gateway 116 / ledger 62 / 其余包通过，exit 0）。
> 本轮新增红测 **4 文件 10 用例（9 红 1 绿对照）**，全部真实复现（非推断）。
> 修复顺序建议：R1 → R2 → R4 → R3 → R6 → 其余加固项。

---

## R1【P0 · 资金冻结】request.failed 释放路径不递减 users.reserved_balance

- **红测**：`packages/ledger/src/__tests__/billing-flow.payg-release.red.test.ts`（3 用例全红）
- **实时复现**：`scripts/security-audit/20-boundary-billing-e2e.mts` S5（上游 429 → 账单
  `released`，但 `users.reserved_balance=0.001007000000000000` 永久滞留）
- **根因**：`packages/ledger/src/billing-flow.ts:894-954` 的失败释放事务只释放套餐敞口
  （userSubscriptions.reservedAmount）和渠道敞口（channels.upstreamReserved），没有
  `users.reserved_balance -= paygPart`。git 考古：`48a8718` 同时删了「预占」与「释放」
  （当时自洽）；`c646f20` 恢复了 authorize 的余额预占（billing-flow.ts:619-638），
  **释放块没有一起恢复**——破坏性变更没做完整。
- **兄弟路径对照**（都正确递减）：`billing-operations.ts:104-109`（releaseReservations）、
  `settle.ts:127-137`、`billing-processor.ts:353-358`（recoverOnce）。
- **影响**：PAYG（未绑定订阅的 Key）用户每次失败请求（上游 429、invalid_request 4xx 透传、
  circuit_open、channel_budget_exhausted 等 upstreamCharge=none 的失败）**永久冻结**一笔预估
  金额。可用额度 `balance + credit_limit − reserved_balance` 持续缩小直至锁死；套餐购买闸门
  `balance − reserved ≥ price` 同样被卡。红测#2 实测：余额 ¥10 用户发 5 次失败请求后第 6 次
  授权被 `InsufficientBalanceError` 拒绝；红测#3 实测：余额 ¥2 用户失败一次后连等额新请求都发不出。
- **存量佐证**：`reconcileUser`（reconcile.ts:71-99）能发现该漂移但只记
  `reconcile_discrepancies`，无自愈。
- **修复方向**：在 signal 释放事务里恢复 payg 递减块（镜像 releaseReservations 的
  `paygPart = amount − planPart`，带 `reserved_balance >= paygPart` 守卫 + returning 校验），
  并补断言 `reservedBalance==0` 的回归用例（现有测试只查渠道列，这正是回归漏网原因）。

## R2【P0 · 资损】零价上架套餐可被任何用户自助订阅，白得额度并变现

- **实时复现**：`scripts/security-audit/18-free-plan-self-subscribe.mts`（exit 1 = RED）
- **实测攻击链**：新用户（余额 ¥1 礼金）→ `POST /api/subscriptions {planId:997}` → **201**，
  白得 loadtest-plan 额度 **¥1,000,000,000、有效期至 2036-08-11**；建绑定订阅的 Key →
  网关真实调用 deepseek-v4-flash → 200；对账 `platform_cost=¥0.0001` 由平台承担，用户余额分文未动。
- **根因**：`packages/ledger/src/ledger.ts` applySubscription 闸门只校验
  `status===0 / kind==='subscription' / 席位规则 / 企业标志`，**没有 price>0（或显式免费套餐
  标志）校验**；余额闸门 `balance − reserved >= price` 对 price=0 恒真。管理端
  （admin-api plans.ts:29,41）建/改套餐已强制 `price>0`，但**购买路径不设防**。
- **存量数据**：`plans` 表 `price=0 AND status=0` 共 **96 行**（含 loadtest-plan ¥10 亿 / 3650 天；
  以及 quota ¥10,000 的 plan-xxx 系列）；已有 5 个用户挂着 ¥10 亿额度订阅（users 5740/7823/7837/7862/7865）。
- **修复方向**：applySubscription 拒绝 `price<=0`（或引入显式免费套餐标志 + 白名单）；
  一次性治理存量（`UPDATE plans SET status=1 WHERE price<=0 AND status=0`，加约束前先清数据）。
- **留档账号**：freeload-786750253302（id 7888，订阅 2585）、freeload-7867502623（id 7889，
  订阅 2586，Key 3778，request_logs 含真实 deepseek 调用）。

## R3【P1 · 资损边缘 + 可用性】订阅 renew/change 三处缺陷

- **红测**：`packages/ledger/src/__tests__/subscription-renew-change.red.test.ts`（4 用例全红）
- **R3-1 renew 丢 orgId**：`renewSubscription`（ledger.ts:821-832）传 `orgId: null`，且 renew
  分支读旧订阅不取 orgId 列（ledger.ts:401-403）→ 组织订阅续费后 `org_id=NULL`，静默变个人订阅：
  全部成员 402（billing-flow.ts:427-437 的成员校验要求 orgId 非空），且新订阅占用
  `user_subscriptions_one_personal_uq` 唯一槽，个人购套餐被误拒 `already_subscribed`。
- **R3-2 change 不重绑凭证且丢 orgId**：renew 有改绑 apiKeys/apps 的逻辑（ledger.ts:509-517），
  changeSubscription 的插入段（ledger.ts:977-989）没有等价逻辑也没有 orgId 字段 → 用户付了升档
  差价后所有绑定 Key/App 全部 402 `subscription_required`；org 订阅升档同样全员断供。
- **R3-3 已取消订阅可复活**：renew 按裸 id 读订阅无 status 过滤（ledger.ts:401-403，对比
  change 的 `status=0 AND endAt>now`）→ 管理员取消（status=2，风控/退款场景）的订阅，用户
  自助 renew 即复活（红测实测新订阅 2593 创建成功）。
- **附带（未单列红测，纯竞态）**：change 的旧订阅状态翻转（ledger.ts:936-940）无 returning/
  rowCount 校验，与 cancel 并发时静默匹配 0 行仍继续补差价——按已作废的剩余价值给抵扣（少收）。
- **修复方向**：renew/change 读取并继承 orgId + quantity；change 补凭证改绑；renew 加
  `status=0` 过滤；change 的状态翻转加 returning 校验（0 行 → no_subscription）。

## R4【P1 · 采购敞口失守】reserveChannel 预算校验 check-then-act，并发超扣

- **红测**：`packages/ledger/src/__tests__/channel-budget-race.red.test.ts`（确定性复现：
  外部事务锁渠道行制造交错 → 两笔各 ¥10 的 reserve 全部 `allowed:true`，
  终态 `upstream_reserved=20 > budget=10`）
- **根因**：`billing-flow.ts:695-734` 先 findFirst 读预算（无 FOR UPDATE）再无条件
  `UPDATE ... WHERE id=?`——WHERE 里没有 `upstream_budget − upstream_reserved >= amount` 守卫。
  同文件的用户预占（:619-638）与套餐预占（:601-613）都是条件原子 CAS，渠道是唯一漏网；
  DB 也没有 `upstream_reserved <= upstream_budget` CHECK。
- **存量佐证**：33 个渠道共 **¥3.02** 的 upstream_reserved 已无任何在途账单支撑
  （`reconcileChannelReserved` 定义了但从未被 worker 调度，且其状态清单漏了 `dead`）；
  测试清理 helper（apps/gateway/src/testing/helpers.ts:256-267）删账单不平渠道投影，同类遗漏。
- **修复方向**：把守卫放进 UPDATE 的 WHERE + RETURNING 判定（镜像用户路径）；worker 接线
  reconcileChannelReserved（补 dead 状态）；channels 加 CHECK 约束；修 test helper 投影清理。

## R5【P1/P2 · 安全】认证面三缺陷（实时复现）

- **脚本**：`scripts/security-audit/19-oauth-lockout-session-nan.mts`（3 项全 RED）
- **R5-1 OAuth client_id 锁死 DoS（P1，企业客户可用性）**：`gateway/src/services/auth/oauth-service.ts:47-58`
  按 client_id 计数、锁定判断在密钥校验之前——正确凭证也被 429。实测：10 次错误 secret 后，
  正确 secret 换令牌 → `429 rate_limit_exceeded`。client_id 是公开标识，匿名者可持续打断
  付费客户的令牌交换。登录路径已有「正确密码豁免」（auth.ts:55-65），OAuth 路径没有同等语义。
- **R5-2 改密不注销会话（P1，横向移动窗口）**：`POST /api/auth/password` 只改
  password_hash（client-api auth.ts:108-109），无状态会话 JWT（24h，无 jti/版本号）→ 实测改密
  后旧 cookie 依旧 200 `/api/me`。admin 侧重置密码同样不吊销（users.ts:176-189）。会话泄露场景
  下受害者改密无法自救，只能封号。gateway 侧 jti 黑名单是只读死代码（无任何写入方）。
- **R5-3 路径参数 NaN → 500（P2，错误语义）**：admin-api 17 处 `Number(c.req.param('id'))`
  裸解析（channels.ts:163/205/226、models.ts:143/178/198/210、providers.ts:60/86、
  redeem.ts:87/95/126、rate-cards.ts:76/83/103/134、keys.ts:80、client-api apps.ts:114/137），
  实测 `PATCH /api/admin/channels/abc` → `500 INTERNAL_ERROR`（PG 22P02）。仓库自有
  `intParam`（packages/http/src/params.ts）就是为了防这个，新路由没全用。
- **修复方向**：R5-1 锁定前先恒定时间校验（正确即放行并清零）；R5-2 users 加 token_version
  或 sessions 表（P1 计划已有）；R5-3 全量换 intParam。

## R6【P1 · 口径分裂】is_free 标志与非零价格两套计费口径

- **红测**：`packages/ledger/src/__tests__/free-model-inconsistency.red.test.ts`（1 红 1 绿对照）
- **实时证据**（脚本 20 第一轮，账号 7908）：is_free=true + 价 1/1/1 的模型 →
  **授权 0 元**（billing-flow.ts:187 `explicitlyFree → 0`，不校验余额）+ **结算实扣
  ¥0.001002**（calcAmount 按价格表）。授权看标志、结算看价格。
- **危害**：单一真相破坏；0 余额用户可无限发起请求（绕过余额闸门），结算实扣可能超余额 →
  信用地板违规 → retry_wait/dead 堆积人工复核（放大 R1 类异常）。管理端
  （admin-api models.ts:56/124/153）接受 isFree 与任意价格组合，无互斥校验。
- **修复方向**：authorize 拒绝「explicitlyFree 但候选价格非全零」（invalid_quote），与既有用例
  「全零价但未标 explicitlyFree → invalid_quote」互为镜像；管理端同步校验互斥。

---

## 静态审查发现（代码证据充分，未逐个动态复现，按优先级）

### 安全加固（P2）
- **登录爆破与 XFF**：`packages/identity/src/login-throttle.ts:88-98` 无条件信任 XFF 第一跳，
  锁定绑 (identifier, ip) → 换 XFF 即绕过（回归测试 auth-throttle-xff.test.ts:87-94 甚至固化了
  该行为）。硬锁只防同源爆破；identifier-only 计数「绝不锁定」。admin 登录同路径。
- **上游错误信息透传**：`packages/ai/src/errors/classify.ts:128` + llm-pipeline.ts:1105-1111
  把上游 message/bodyCode 原样返回终端用户（api-contract.md:17 承诺剥离）——供应商报错常带
  真实模型 id（如 `nvidia/nemotron-...:free does not exist`），白标改写只覆盖成功帧。
- **rotate-encryption-key.ts 泄密**：scripts/rotate-encryption-key.ts:41,50 把新旧密钥前 8 字符与
  明文片段打到 stdout；且轮换设计非事务、无 key 版本列、无双 key 解密窗，中断即渠道半瘫。
- **DEV_FAKE_ME 无 NODE_ENV 门控**：apps/admin/src/lib/server/get-user.ts:23-30、client 同款——
  一个 env 变量进生产即渲染带假身份的管理壳。
- **登录无审计**：client-api/admin-api 登录成功/失败/锁定均不写 audit_logs（36 个 action 无一
  登录类）；模型市场导入审计 actor 硬编码 `adminId: null`（model-catalog.ts:277-284）。
- **管理面无职责分离**：单层 admin 可 gift/adjust（上限 ¥1e9/次、可重复）、建兑换批次、裁决
  账单——全有审计但无 maker-checker/角色分级（内部人风险）。
- **免费模型滥用面**：免费模型 0 元授权不计入每日花费上限（amount=0），无独立 RPM/日请求数
  闸；目录价漂移（上游开始收费）只有 UI 黄标无自动处置。

### 设计/架构（P2-P3）
- **文档与实现漂移（高危误导）**：requirements.md:23/177/230 与 data-model.md:227 仍写
  「不产生负余额/实际不超预估才结算」，而实现已是信用模型（settle.ts:77-80 明确注释删除了
  该不变量）。按文档修代码会把账本改坏。
- **usage_logs/transactions 零 CHECK**：amount/plan_amount/payg_amount/upstream_cost 非负、
  `amount = plan_amount + payg_amount (status=0)`、`balance_after = balance_before + amount`
  全部只靠应用层；rate_card「每卡唯一 global 行」因 NULLS DISTINCT 可重复（billing.ts:53）；
  model_mappings 接受负价（zod 无 min(0)），负价经 calcAmount 钳 0 → 静默免费。
- **网关私有一份 Redis 键名副本**：packages/http/src/cache.ts:19-29 与 gateway 的
  key-auth-cache.ts:20 / auth-service.ts:263 / model-router.ts:21 硬编码同名字符串——吊销即时性
  依赖两处字面量一致（cache.ts 注释自认历史边界）。
- **死代码/双路径**：bad_debt 解冻分支无任何写入方（ledger.ts:301-307/762-767）；
  request_logs.candidates_tried 死列 + attempts 恒 1；auto-release 白名单
  `rate_limit_error` 已被归一化废弃（auto-release.ts:19）；formatYuan/MeInfo.role 幽灵兼容字段。
- **金额类型漂移**：/api/usage/summary cost 为 string、/api/usage/by-model 为
  `Number(r.cost)`（IEEE754 化金额聚合，违反全程字符串纪律）；api-client types.ts 与实返回
  双向漂移（UsageRow 幻影字段 statusCode、缺 appId/apiKeyId）。
- **request_logs 分区未实施**：data-model.md:341 承诺按月分区 30 天滚动，实际普通无界表
  （trace_spans 有完整分区机制，request_logs 没有）。
- **org 创建在账本事务外**：subscriptions.ts:66-91 先插 organizations/org_members 再跑
  ledger.subscribePlan，余额不足时留下孤儿 org（可无限刷行）。
- **apps 绑定订阅无归属校验**（keys 有 assertCanUseSubscription，apps.ts:96 没有）——授权时
  兜底校验存在，属纵深防御缺失而非漏洞。
- **HS256 密钥允许 16 字符**（core/env.ts:71,176,209），低于 32 字节最佳实践。

### 验证为可靠（无需改动，防误修）
- 金额核心：单一 calcAmount 公式、Decimal 全程、numeric(38,18) 字符串落库、无 parseFloat/
  Math.round 触钱；真实模型 20 并发 + MiniMax 对账分毫不差（脚本 21 全绿）。
- 原子 CAS：用户余额预占、套餐额度预占、结算 claim/fencing（最终语句 CAS 复查）、redeem
  单笔原子认领、signup 礼金幂等、订阅唯一索引兜底 23505。
- XSS：两个前端仅静态主题串用 dangerouslySetInnerHTML，无用户输入注入面；密钥/兑换码只存
  SHA-256；密钥/令牌/渠道凭据展示全部脱敏。
- 注册关闭（无自助注册端点），账号由管理员开通；client/admin/gateway 三面凭证物理隔离。

---

## 回归与记录

| 项 | 结果 |
|---|---|
| 基线 `pnpm test`（改动前） | 全绿 exit 0 |
| 红测套件（4 文件） | 9 红 1 绿（对照），全部真实复现 |
| 脚本 18（零价套餐） | RED（exit 1）：201 白得 ¥10 亿 |
| 脚本 19（认证三缺陷） | RED（exit 1）：3/3 复现 |
| 脚本 20（临界值 E2E） | 6 绿 1 红：S5=R1 实时实锤 |
| 脚本 21（真实模型对账） | 全绿 exit 0（deepseek 20 并发、MiniMax-M3、gpt-oss-20b） |

> 红测文件带 `.red.test.ts` 后缀；修复业务代码后应全部转绿并保留（转普通回归）。
> 测试数据全部保留未清理，账号清单见 [ACCOUNTS-2.md](./ACCOUNTS-2.md)。


---

# 修复记录（2026-08-15 同日完成，TDD：红测已全部转绿）

> 验收口径：全量回归 `pnpm test --force` exit 0（13 包 568 用例）+ `pnpm typecheck` 17/17 +
> `pnpm lint` 17 包 0 错误 + 脚本 18/19/21 exit 0 + 脚本 20 七场景（S3 需等满 10 次结算重试退避）。
> 涉及脏数据的缺陷（R2/R6/R4）均先用**自造干净数据**红测复现再修复——不依赖库内任何存量行。

## R1 · request.failed 补齐 PAYG 预占释放（组件化下沉）

- **改法**：新增 `packages/ledger/src/release.ts` 的 `releaseReservedAmounts()`——三类预扣投影
  （users.reserved_balance / user_subscriptions.reserved_amount / channels.upstream_reserved）
  同步释放的唯一实现，错误语义由调用方注入。四个消费方收口：signal 失败释放（补上遗漏的
  余额部分）、recoverOnce 过期回收、resolve/abandon 人工路径；settle 的「释放+扣款」合并
  语句语义不同保持独立。
- **涉及**：`release.ts`（新增）、`billing-flow.ts`、`billing-operations.ts`、`billing-processor.ts`。
- **测试**：`billing-flow.payg-release.red.test.ts` 3 用例红→绿（含「5 次失败不得锁死用户」）；
  脚本 20 S5 实时验证：上游 429 → released 且 `reserved_balance=0`。

## R2 · 零价套餐购买闸门 + 存量治理

- **改法**：`ledger.ts` applySubscription（purchase 与 renew 共用计划加载处）与
  changeSubscription 目标套餐处增加 `price<=0 → plan_not_purchasable`（资金侧最后防线）；
  新增错误码并映射 client-api 400 `PLAN_NOT_PURCHASABLE`。管理端建/改套餐原本已强制正价。
- **测试**：`free-plan-gate.red.test.ts`（自造零价套餐）2 用例红→绿——购买拒绝且不留订阅、
  历史脏订阅续费拒绝；脚本 18 exit 0（脏套餐再生成也被闸门拦截，实测 400）。
- **治理**：两轮下线全部零价上架套餐（96 + 294 个，后者为测试 fixture 再生）；作废零价套餐
  在订 6 条（含脚本 18 的 2585/2586 与历史 ¥10 亿订阅）。测试 fixture 会持续再生零价套餐行，
  闸门保证其不可被购买（防御不依赖数据卫生）。

## R3 · 订阅生命周期三处修复

- **改法**（`ledger.ts`）：renew 分支读旧订阅补 `orgId` 列并继承到新订阅；change 的 current
  读取补 `orgId` 并写入新订阅；change 补 apiKeys/apps 改绑（与 renew 同语义）；renew 读取加
  `status=0` 过滤（已取消/被替换订阅不可复活）；renew 与 change 的旧订阅状态翻转均加
  `.returning()` + 0 行 → `no_subscription`（与取消并发时不得按作废额度抵差价）。
- **测试**：`subscription-renew-change.red.test.ts` 4 用例红→绿；既有订阅套件 24 用例不回归。

## R4 · 渠道预算原子守卫 + 对账接线 + 存量治理

- **改法**（`billing-flow.ts` reserveChannel）：余额守卫内联进 UPDATE 的
  `WHERE upstream_budget − upstream_reserved >= amount` + RETURNING 判定（0 行 → allowed:false，
  事务原子回退）；billing_requests 状态写入加 `status in (authorized, in_flight)` 守卫
  （与过期回收竞态时不得把渠道敞口落到终态行）。DB 加
  `channels_upstream_reserved_nonnegative_ck`（迁移 0033）。
- **对账接线**：`reconcile.ts` 新增 `reconcileChannels()` 并入 `reconcileAll`（worker 每小时
  覆盖渠道维度）；`reconcileChannelReserved` 状态清单补 `dead`（合法在途，防假差异）；
  `ledger.reconcile` 返回增加 `checkedChannels`。
- **测试基建**：`apps/gateway/src/testing/helpers.ts` 清理时先收集用户账单的渠道敞口再删账单、
  删除后同步清零渠道投影（消除 sfch2-* 类无主敞口的再生源）。
- **治理**：33 个渠道 ¥3.02 无主敞口清零；19 个负预算渠道归零。
- **测试**：`channel-budget-race.red.test.ts` 确定性并发红→绿（同交错下 20>10 变为 10=10）。

## R5 · 认证面三修复

- **R5-1**（`oauth-service.ts`）：锁定判断移到「错误凭证」路径——先恒定时间验签，正确凭证
  无条件豁免并清零计数（与登录路径「正确密码豁免」同语义）；错误尝试仍计数锁定。
- **R5-2**（会话吊销锚点）：users/admins 新增 `session_invalid_before`（迁移 0034）；会话 JWT
  增加毫秒级 `iatMs` 自定义声明（`verifySession` 透传），中间件精确到毫秒比较——同秒内
  「改密前签发的旧 token」必死、「改密后重新登录」必活（秒级 iat 无法区分，这是唯一治本方案）；
  三处改密点写入失效线：用户自助（client-api auth.ts）、管理员重置（setUserPassword）、
  管理员自助（admin-auth.ts）。
- **R5-3**：17 处 `Number(c.req.param(...))` 全量替换为 `intParam`（channels/models/providers/
  redeem/rate-cards/keys/admin、client-api apps）。
- **测试**：脚本 19 三项全绿 exit 0（正确 secret 换令牌 200、改密后旧 cookie 401、NaN id 400）；
  手动全链路验证「登录→改密→旧会话 401→新密码重登 200」。

## R6 · is_free 与价格口径统一（免费 ⇔ 全零价）

- **改法**（三层防线）：
  1. 账本层 `billing-flow.calculateRequired`：explicitlyFree 但候选价格非全零 → `invalid_quote`
     （与既有「全零价未标免费 → invalid_quote」互为镜像）；
  2. 管理端 `services/models.ts` 新增 `assertFreePriceConsistency()`（单一真相），创建/更新
     走合并态校验；价格字段同时加 `min(0)`（顺带修复负价可入库）；
  3. 目录导入 `model-catalog.ts`：`is_free` 由价格单一决定（`catalogFree = 全零价`）——上游
     漂移出非零价按**付费**导入（priceWarning 告警），绝不落矛盾配置。
- **测试**：`free-model-inconsistency.red.test.ts` 红→绿（对照用例保持绿）；
  `model-catalog.test.ts` 加强断言「价格更新为非零 → is_free 同步翻 false」。
- **治理**：3 个矛盾模型（rede2e-free-*，本轮测试产物）价格归零。

## 测试稳定化（共享环境竞态，非产品缺陷）

真实 worker 与测试内 processor 会赛跑 claim 同一账单（共享 Redis 队列）：org-invite.e2e 改
轮询等待 usage 落库；pipeline-error-paths 的 waitFor 放宽到 10s；chat-fallback-pricing 状态
断言补 `processing`（价格快照在 claim 前已写定）。全量并行偶发 503 为准入控制对结算积压的
正确反应（长退避 dead-letter 推高队列），队列排空后全绿。

## 数据治理总账

| 项 | 动作 | 量 |
|---|---|---|
| 零价上架套餐 | status→1（两轮，测试 fixture 会再生，闸门兜底） | 96 + 294 |
| 零价套餐在订 | 作废（status→1） | 6 条 |
| 渠道无主敞口 | upstream_reserved→0 | 33 渠道 ¥3.02 |
| 负预算渠道 | upstream_budget→0 | 19 |
| is_free 矛盾模型 | 价格归零 | 3 |
| schema | 迁移 0033（channels CHECK）、0034（session_invalid_before×2 表） | 已应用 |
