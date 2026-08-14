# 计划：组织/成员计费（席位=成员名额 + 凭证绑定计费账户）

> 状态：已确认，TDD 实施中
> 原则：治本不治标 / 删除优于兼容 / TDD 红绿 / 组件化下沉 / 破坏性变更一次做完整 / 错误语义分级 / 测试数据纪律 / 回归即验收

## 1. 背景与目标

上一步「Key 类型分流」是**过渡补丁**（key 分 payg/subscription），它在没有「成员」实体的前提下临时解决了「企业额度 vs 个人余额」的分流。但它有三个缺陷：

1. 用量无法归到「具体成员」（全挂在一个企业账号下）。
2. 无法「控制每个成员的使用量」。
3. 「席位」语义错位（拿它去卡 key 数，行业里席位=成员名额）。

本计划把它重构为行业标准的**组织/成员模型**，彻底解决上述问题，并**删除 `api_keys.kind`**（被更具体的 `subscription_id` 取代）。

## 2. 决策记录（已确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 计费来源 | **凭证级绑定计费账户**：`api_keys.subscription_id` / `apps.subscription_id`，NULL=余额 |
| 2 | key 是否保留 | **保留**（agent 程序化调用必须用 key/JWT），但归属**成员本人**（`api_keys.user_id`=成员） |
| 3 | 每套餐 key 数 | **允许多把**（多 agent/多成员各配一把，单独吊销、单独看用量）；刷新=轮换某一把（吊销旧+发新） |
| 4 | 席位语义 | **成员数 ≤ quantity**；owner 占 1 席；**拒绝降级**（quantity 只增不减） |
| 5 | 成员多组织 | 允许；用户通过「选择不同绑定的 key」切换用哪个套餐/余额 |
| 6 | 用完不自动切 | 套餐额度尽 → 硬顶 402，**不自动落余额**（用户换 key 才切来源） |
| 7 | 每成员用量控制 | a 成员日限 + b 成员子配额 + c 共享池/限流，**全要**；超限硬顶 402，不溢出共享 |
| 8 | 个人套餐 | `user_subscriptions.user_id`（org_id=NULL）；企业套餐 `org_id` 非空（user_id=owner） |
| 9 | 离开组织 | 历史 usage 保留归属（只改成员 status）；离开/移出时其绑定该 org 订阅的凭证改绑 NULL（余额）或吊销 |
| 10 | `api_keys.kind` | **删除**（字段、CHECK、类型、authorize/settle 分支、前端选择器、文档一次删净） |

## 3. 数据模型

### 3.1 新表

**organizations**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| name | varchar(64) | 组织名 |
| owner_user_id | FK users | owner（也是成员，占 1 席） |
| created_at / updated_at | timestamptz | |

**org_members**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| org_id | FK organizations | |
| user_id | FK users | 成员 |
| role | varchar(16) | `owner` / `member` |
| status | smallint | 0 active / 1 left |
| daily_spend_limit | numeric NULL | 成员日限（a，作用于 org 套餐内消耗） |
| monthly_quota | numeric NULL | 成员子配额（b，作用于 org 套餐内消耗） |
| created_at / updated_at | timestamptz | |

- UNIQUE(org_id, user_id)；INDEX(user_id)。**不加** unique(user_id)——成员可多组织。

**org_invitations**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| org_id | FK organizations | |
| email | varchar(255) | 邀请目标邮箱 |
| token | varchar(64) UNIQUE | 邀请链接 token |
| invited_by_user_id | FK users | 发起人 |
| status | smallint | 0 pending / 1 accepted / 2 revoked / 3 expired |
| expires_at | timestamptz | 过期时间 |
| accepted_by_user_id | FK users NULL | 接受人 |
| created_at / updated_at | timestamptz | |

### 3.2 改表

**user_subscriptions**：加 `org_id FK organizations NULL`（个人=NULL；企业=org）。唯一约束从「每 user 一条 active」改为：

```sql
-- 个人：每用户至多一条 active（org_id IS NULL）
UNIQUE(user_id) WHERE status=0 AND org_id IS NULL
-- 企业：每组织至多一条 active（org_id 非空）
UNIQUE(org_id)  WHERE status=0 AND org_id IS NOT NULL
```

**api_keys**：加 `subscription_id FK user_subscriptions NULL`；**删 `kind` 列 + `api_keys_kind_ck` + `ApiKeyKind` 类型**。

**apps**：加 `subscription_id FK user_subscriptions NULL`。

**usage_logs**：保留 `billed_by CHECK (plan/payg)`（`both` 已结构性删除）。

## 4. 计费判定（authorize/settle，单一真相）

```
凭证 ── api_keys.subscription_id / apps.subscription_id ──▶
    NULL           → payg：扣余额（现逻辑）
    非空           → subscription：扣该订阅额度（现逻辑）
```

- authorize 直读凭证的 `subscription_id`（不信任调用方传参）：apiKeyId 非空读 `api_keys.subscription_id`；否则 appId 非空读 `apps.subscription_id`；都没有 → NULL（余额）。为此 `AuthorizeBillingCommand` 增加 `appId`。
- **防御校验**：`subscription_id` 非空时必须「用户=订阅 owner，或用户是该订阅 org 的 active 成员」，否则拒绝（`SUBSCRIPTION_FORBIDDEN` 402）。防止成员拿一把绑到别人套餐的 key。
- **成员日限 a / 子配额 b**：当 `subscription.org_id` 非空时，读 `org_members(org_id, user_id, status=0)`，若设了 `daily_spend_limit`/`monthly_quota`，按「该成员今日/本月在**该 org 订阅**下的 usage_logs 之和 + 在途敞口 + 本次预估」校验，超 → 402 `MEMBER_DAILY_LIMIT` / `MEMBER_QUOTA_EXCEEDED`。硬顶，不溢出共享。
- settle：按 `billing_requests.subscription_id` 分流（现逻辑不变）；`usage_logs.user_id`=成员、`subscription_id`=org 订阅、`billed_by=plan`。

## 5. 邀请流程

1. owner 发起邀请（email）→ 校验席位余量（active 成员数 < quantity）→ 生成 token+链接，落 `org_invitations(pending)`。
2. 被邀请人打开链接，**必须已登录 C 端**，且登录账号 **email（或 subject）与邀请 email 一致**，否则拒绝。
3. 接受 → 事务内：`FOR UPDATE` 锁 org 订阅行 → 复检席位余量 → `INSERT org_members(active)` → 邀请标记 accepted。并发安全靠订阅行串行化。
4. 边界：撤销（revoked）、过期（expired）、重复接受（幂等）、已被占用（幂等返回）。

## 6. 代码改动面（文件级）

| 层 | 文件 | 改动 |
|---|---|---|
| db | `schema/organizations.ts` + `org-members.ts` + `org-invitations.ts` | 新表 |
| db | `schema/user-subscriptions`（plans.ts） | 加 org_id；改唯一约束 |
| db | `schema/api-keys.ts` | 删 kind + 加 subscription_id |
| db | `schema/apps.ts` | 加 subscription_id |
| db | 迁移 0032 | 上表 + 删 kind（0031 已落地 kind，本迁移收编） |
| ledger | `types.ts` | `AuthorizeBillingCommand.appId`；删 billingKind 相关 |
| ledger | `billing-flow.ts` | authorize 读 subscription_id 分流；防御校验；成员 a/b 上限 |
| ledger | `settle.ts` | 零改（subscription_id 已分流） |
| client-api | `routes/orgs.ts`（新） | 建 org / 邀请 / 成员列表 / 设成员配额 / 移除成员 / 接受邀请 |
| client-api | `routes/keys.ts` | 创建/轮换带 subscription_id（选来源）；删 kind |
| client-api | `routes/apps.ts` | 创建带 subscription_id |
| client-api | `routes/subscriptions.ts` | 企业购买写 org 订阅（org_id） |
| gateway | `auth-service.ts` | 删 billingKind（凭证鉴权不再需要类型）；pipeline 传 appId |
| 前端 | client org 管理 + 邀请接受 + key/app 来源选择 | 新页面/弹窗 |
| 文档 | requirements/data-model/api-contract | 收敛 org/member 口径，删 kind |

## 7. TDD 清单（红→绿）

**ledger（真 PG）**
1. subscription_id=NULL → payg 预留/结算（既有回归）
2. subscription_id=个人订阅 → 扣个人额度、余额不动（回归，改用凭证绑定）
3. subscription_id=org 订阅 + active 成员 → 扣 org 额度、usage_logs.user_id=成员
4. 防御：绑到无权 org 订阅 → 402 拒绝
5. 成员日限 a：当日该成员 org 消耗 + 在途 + 预估 > daily_spend_limit → 402
6. 成员子配额 b：当月该成员 org 消耗 > monthly_quota → 402
7. 并发：org 额度共享池并发预留不超额度；席位并发接受不超发

**client-api（真 PG/HTTP）**
8. 邀请接受：登录态 email 匹配 → 加入；不匹配 → 拒绝；席位满 → 409；并发不超发
9. 席位：active 成员数 ≤ quantity；降级 quantity < 成员数 → 400 拒绝
10. key 创建：带 subscription_id 绑定来源；换 key=换来源
11. 企业购买 → 建 org + org 订阅；owner 自动占 1 席
12. e2e：成员用自己的 key 调 → 扣 org 额度、归成员名下；额度尽 402 不落余额

## 8. 提交切分（同一特性分支，一次完整落地）

| # | 提交 | 范围 |
|---|---|---|
| 1 | db+ledger | 迁移 0032 + authorize 订阅绑定/防御/成员上限 + TDD 1-7 |
| 2 | client-api | org/member/invitation 路由 + key/app 绑定 + 订阅企业购买 + TDD 8-11 |
| 3 | gateway | 删 billingKind、pipeline 传 appId |
| 4 | 前端 | org 管理 + 邀请接受 + key/app 来源选择 + 成员配额 |
| 5 | 文档 + 端到端验收 | 文档收敛 + 真实验收 |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 席位超发 | 邀请接受事务 + 订阅行 FOR UPDATE + 计数校验（串行化） |
| 成员切错来源 | 凭证绑定显式可见；authorize 防御校验兜底 |
| 成员离开后脏绑定 | 移出/离开事务内把其绑定该 org 的凭证改绑 NULL |
| 半迁移 | schema+ledger+api+前端+文档+测试一次变更 |
| 存量企业用户 | 迁移：建 org、owner 为本人并占 1 席；存量订阅挂 org_id；存量 key 挂 owner |

## 10. 明确不做（本期边界）

- 组织审批流 / 成员多级角色（owner/admin/member 分级）
- 组织间额度划转、多级结算
- 在线支付 / payment_orders
- 渠道进货额度、TPM/RPM、费率卡（正交）
