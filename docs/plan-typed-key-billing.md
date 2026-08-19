# 计划：Key 类型分流计费（包月 Key / 普通 Key）

> 状态：已实施；后被 plan-org-member-billing 成员模型取代（api_keys.kind 列已删）
> 原则：治本不治标 / 删除优于兼容 / TDD 红绿 / 组件化下沉 / 破坏性变更一次做完整 / 错误语义分级 / 测试数据纪律 / 回归即验收

## 1. 背景与根因

- **现象**：`dev@ai-gateway.local`（余额 ¥10875、7 把活跃 Key、无订阅）用 Key 调用任意模型 → 402「无有效订阅（未订阅或已到期）」。
- **根因**：`billing-flow.ts` authorize 的「订阅即闸门」把计费身份绑定到**订阅状态**，并抽掉了余额（payg）的授权预留与结算扣款两根线；而设计文档口径是余额按量与套餐订阅**共存**。
- **模型定案（用户拍板）**：**Key 是有类型的，计费域严格隔离**——
  - **包月 Key**（`subscription`）：只扣套餐额度，永不碰余额；额度尽 402；无有效订阅 402。
  - **普通 Key**（`payg`）：只扣余额（含信用透支），永不碰套餐额度；余额不足 402。
  - 有套餐的用户拿普通 Key 调用 → 只扣余额，额度不动（判定性用例）。
- **现状盘点结论**：payg 骨架完整自洽（`users.reserved_balance`/信用地板 CHECK/释放路径/reconcile 公式/`transactions.type='consume'` 部分唯一索引全部健在），只需接回「授权预留」与「结算扣款」两处。

## 2. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| 1 | 席位语义 | **不在本期**：`quantity` 保持为套餐计价维度（总额度 = 档额度 × 席位），**不约束 Key 数量**。创建包月 Key 仅要求「存在有效订阅」，不设数量闸（避免与 df2c4ea 的解耦冲突；额度硬顶已天然限制总消耗） |
| 2 | 包月结算溢出（ε） | **沿用现状**：`subscription_quota_exhausted_during_settle` → invariant → dead 人工复核（不记坏账） |
| 3 | 存量 Key 迁移 | 一次性回填：用户有活跃订阅 → `subscription`；无 → `payg`。确定性 CASE，无治理。**回填不改变席位语义**（quantity 不参与） |
| 4 | 普通 Key 透支 | 沿用信用模型：`balance ≥ -credit_limit`（DB 地板约束已在） |
| 5 | kind 判定真相 | **单一真相 = `api_keys.kind`**：authorize 直读该列分流（apiKeyId=null 的 JWT 恒 `payg`）；`billingKind` 不进入 `AuthorizeBillingCommand`、不进 Redis 鉴权缓存载荷（消除信任边界） |
| 6 | kind 不可变 | 创建后不可改（轮换保留类型）。无改型路径 → 无改型缓存失效问题 |

## 3. 目标行为规格

### 3.1 Key 生命周期

| 操作 | 普通 Key (payg) | 包月 Key (subscription) |
|---|---|---|
| 创建 | 自由（现行为） | 需有效订阅（status=0 且未到期），否则 402 `SUBSCRIPTION_REQUIRED`。**无席位闸** |
| 轮换 | 保留类型（复制 kind） | 同左 |
| 吊销/改名/限流 | 不变 | 不变 |

### 3.2 调用计费（authorize）

- authorize 先按 `api_keys.kind`（apiKeyId=null → `payg`）分流：

| Key 类型 | 授权路径 | 拒绝语义 |
|---|---|---|
| subscription | 现逻辑不动：订阅闸门 → 额度硬顶 → 原子预占 `user_subscriptions.reserved_amount` | 402 `subscription_required` / `subscription_quota_exhausted` |
| payg | `balance + credit_limit − reserved_balance ≥ 预估` → 原子预留 `users.reserved_balance += 预估`（WHERE 可用额度条件，与套餐预占同款原子模式） | 402 `insufficient_balance`（gateway 映射已在） |

- billing_requests：payg 行 `subscription_id`/`plan_reserved_amount` 为 NULL；`reserved_amount` 即余额在途敞口。
- 金额为 0（免费模型）：沿用现有 fast-path，不预留、不落余额动作。**注意：payg 分支不得先走订阅闸门**（0 元判定先于/独立于订阅判定）。
- 日限（用户级/Key 级）基于 usage_logs + billing_requests 敞口，双轨通用，不改。

### 3.3 结算（settleClaim）

按 `billing_requests.subscription_id` 分流（authorize 落列的权威事实，无需在 receipt 加字段）：

| 类型 | 结算动作 |
|---|---|
| payg | ① 单条原子 UPDATE：`reserved_balance -= reserved` 且 `balance -= 实扣`（WHERE `reserved_balance ≥ reserved`；信用地板由 `users_balance_credit_floor_ck` 兜底，23514 → 既有 classify → dead）② 写 `transactions(type='consume', ref_type='usage_logs', ref_id=requestId, amount=-实扣, balanceBefore/After)`（靠 `transactions_consume_ref_uq` 幂等）③ usage_logs：`billed_by='payg'`、`payg_amount=实扣`、`plan_amount=0`。0 元：只写 usage_logs，不扣款不流水 |
| subscription | 现逻辑不动（billedBy 恒 `plan`，含 ε 溢出 → dead 复核，决策 #2） |

- `billed_by='both'` 结构性不可达：**加 DB CHECK 强制 `billed_by in ('plan','payg')`**（先校验存量无 `both` 行）。

### 3.4 回收与对账（零改动，补回归）

- recovery/abandon 的 `paygPart = reserved − plan_reserved` 余额释放路径本就健在——补测试覆盖。
- reconcile 三条不变量（余额/用量-流水/订阅在途）公式不变，补 payg 用户对账用例。

### 3.5 鉴权链

- `AuthContext` 增加 `billingKind`（仅用于可观测 span 属性 `billing.kind`）；静态 Key 从 `api_keys.kind` 读，JWT 恒 `payg`。
- `billingKind` **不传给** `authorize`（authorize 自己读 `api_keys.kind`，单一真相）。
- Redis 鉴权缓存载荷**不**加 kind（kind 不可变，authorize 用 DB 直读，与缓存无关）。

## 4. 数据库变更（迁移 0031）

```sql
-- drizzle schema: api_keys 增加 kind varchar(16) notNull + CHECK（注意：varchar(8) 装不下 'subscription' 12 字符）
ALTER TABLE "api_keys" ADD COLUMN "kind" varchar(16);
-- 存量回填（决策 #3，确定性）
UPDATE "api_keys" k SET kind = CASE WHEN EXISTS (
  SELECT 1 FROM "user_subscriptions" us
  WHERE us.user_id = k.user_id AND us.status = 0 AND us.end_at > now()
) THEN 'subscription' ELSE 'payg' END;
ALTER TABLE "api_keys" ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "kind" SET DEFAULT 'payg';
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_ck" CHECK ("kind" in ('payg','subscription'));

-- billed_by 结构性删除 'both'：先查证存量无 'both' 行再上约束
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_billed_by_ck" CHECK ("billed_by" in ('plan','payg'));
```

- 生成方式：schema 改动 → `pnpm db:generate` → 在生成的迁移文件中插入回填 UPDATE（应用前编辑）。
- 前置校验：① `usage_logs` 无 `billed_by='both'` 行；② 回填为确定性 CASE，无治理需求。

## 5. 代码改动面（文件级）

| 层 | 文件 | 改动 |
|---|---|---|
| db | `packages/db/src/schema/api-keys.ts` | kind 列（varchar(16) + `$type<ApiKeyKind>()` + default 'payg' + CHECK） |
| db | `packages/db/src/schema/usage.ts` | billed_by CHECK |
| db | 迁移 0031 | 上表 |
| ledger（历史落点，现已迁移） | `packages/ledger/src/billing-flow.ts` | authorize 按 kind 分流：payg 原子预留 + InsufficientBalanceError |
| ledger（历史落点，现已迁移） | `packages/ledger/src/settle.ts` | payg 结算（释放/扣款/consume 流水/usage_logs）；删 `billing_invariant_no_subscription` |
| ledger（历史落点，现已迁移） | `packages/ledger/src/billing-operations.ts` / `billing-processor.ts` | 零改动（释放双轨已在）；测试补 payg 释放覆盖 |
| gateway | `apps/gateway/src/services/auth/auth-service.ts` | AuthContext.billingKind（静态 Key 读 kind / JWT 恒 payg） |
| gateway | `apps/gateway/src/services/pipeline/llm-pipeline.ts` | `billing.authorize` span 加 `billing.kind` 属性 |
| client-api | `apps/client-api/src/routes/keys.ts` | 创建/轮换/列表带 kind；包月创建需有效订阅（无席位闸） |
| admin-api | `apps/admin-api/src/routes/keys.ts` | 列表返回 kind（**无创建端点，不加**） |
| client 前端 | `apps/client/.../dashboard/keys/*` | 创建弹窗类型选择；列表类型徽标 |
| admin 前端 | `apps/admin/.../dashboard/rate-limits/*` | Key 项显示类型 |
| api-client | `packages/api-client/src/types.ts` | KeyRow/AdminKeyRow 加 kind |
| 种子/夹具 | `seed-dev.ts` / `seed-loadtest.ts` / `apps/gateway/src/testing/helpers.ts` / 4 处测试文件 | insert 补 kind |
| 文档 | `docs/requirements.md`、`docs/data-model.md`、`docs/api-contract.md` | 删「纯额度/无余额兜底」矛盾句；§4.9 改 Key 类型分流口径；`billed_by=both` 删；api_keys.kind 补录 |

## 6. 错误语义（分级）

| 场景 | 状态 | 码 |
|---|---|---|
| 创建包月 Key 无订阅 | 402 | `SUBSCRIPTION_REQUIRED` |
| 包月 Key 调用无订阅/额度尽 | 402 | `subscription_required` / `subscription_quota_exhausted` |
| 普通 Key 可用额度不足 | 402 | `insufficient_balance` |
| 普通 Key 结算触信用地板 | — | check violation(23514) → invariant → dead（复核，非 500） |

## 7. TDD 清单（红→绿，逐条可复现）

**红（先复现 bug，不接受"理论上会失败"）**
- R1. 有余额、无订阅的 payg Key authorize → 现抛 `SubscriptionRequiredError`（复现 dev 的 402）。
- R2. 有余额、无订阅的 payg Key settle → 现抛 `billing_invariant_no_subscription`。

**绿（ledger 层，真 PG）**
1. 普通 Key（无订阅）authorize：预留 reserved_balance，返回 availableBalance；可用不足 → InsufficientBalanceError，不落 billing_requests
2. 普通 Key settle：扣 balance + consume 流水（balanceBefore/After + ref_type=usage_logs）+ usage_logs(billed_by=payg) + reserved 释放为 0
3. **域隔离**：有活跃订阅用户 + payg Key 请求 → 套餐 used/reserved 全程不变，只动余额
4. 包月 Key：授权/结算/溢出 dead——现状回归（既有用例改用订阅 Key 后继续绿）
5. 0 元 payg：不预留、不流水、usage_logs 记 0
6. 并发：同用户并发 payg 预留不超信用额度（原子 WHERE 语义）
7. recovery/abandon 释放 payg 预留（补覆盖）
8. reconcile：payg 用户 理论余额 == 实际余额
9. 迁移回填正确性（有订阅→subscription / 无→payg）

**gateway/client-api 层**
10. 包月 Key 创建闸：无订阅 402；普通 Key 创建不受限（既有 df2c4ea 用例保持绿）
11. 轮换保留 kind
12. e2e：dev 型用户（无订阅）普通 Key 调用 → 200 扣余额；有订阅用户双 Key 各扣各账

**验收（回归即验收）**
- 四关：lint / typecheck / 全量测试 / 关键端到端
- 真实验收：`dev@ai-gateway.local` 存量 Key（迁移后=payg）真实调用模型成功扣余额

## 8. 提交切分（同一特性分支，一次完整落地）

| # | 提交 | 范围 |
|---|---|---|
| 1 | db+ledger 核心 | 迁移 0031 + authorize/settle 分流 + ledger 全部 TDD（R1/R2/1-9） |
| 2 | gateway | 鉴权链 billingKind + pipeline span + gateway e2e |
| 3 | client-api/admin-api | Key 类型生命周期（10-11） |
| 4 | 前端 | client/admin 类型选择器、徽标 + api-client 类型 |
| 5 | 文档 + 端到端验收 | 文档收敛 + 真实验收记录 |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| payg 预留/扣款并发正确性 | 原子条件 UPDATE（与套餐预占同款）；并发用例 #6；reconcile 兜底 |
| 结算触地板（超额扣款） | DB CHECK 兜底 → dead 人工复核，资金不静默出错 |
| 半迁移状态 | 迁移回填+后端+前端+类型+测试+文档一次变更（本计划 #1-5 连续落地） |
| 既有 e2e 语义漂移 | 订阅路径测试改用「订阅 Key」传 apiKeyId；无 Key/JWT 语义变为 payg |
| 部署期在途 billing_requests | 旧行由既有 sweeper/recovery 收敛，无需迁移（指纹不含 kind 不影响结算分流） |
| 回滚 | 开发环境：`DROP COLUMN kind` + revert 提交；在途 payg 预留由既有释放路径收敛 |

## 10. 明确不做（本期边界）

- 席位闸（quantity=包月 Key 名额）：独立特性，单独立项
- `billed_by='both'` 混扣（结构性删除）
- 在线支付 / payment_orders（二期预留不动）
- 渠道进货额度、TPM/RPM、费率卡（与本变更正交）
