# 数据库文档 · 总览

> 这套文档面向第一次接触 Tillgate 的同学，按业务领域拆分成 10 个分册，逐表解释：
> 这张表为什么存在、每个字段是什么意思、约束为什么这么设计、表与表怎么关联。
> 字段说明全部对照 `packages/db/src/schema/` 下的真实定义编写，以代码为唯一事实来源。

## 0. 项目 30 秒背景

Tillgate 是一个 **OpenAI 兼容的多供应商 LLM 网关平台**（TypeScript/Bun monorepo）：

- 用户（C 端）在网关上创建 API Key / 应用，用 OpenAI 兼容协议调用大模型；
- 平台侧把请求**路由**到不同的上游供应商渠道（渠道里存着加密的上游 Key）；
- 平台对用户**计费**（按 token / 按次 / 按张 / 按秒 / 按字符），用户先充值（余额）或购买套餐（额度）；
- 同时提供管理后台（管理员、RBAC 权限、渠道运营、对账、审计）与可观测能力（请求日志、链路追踪）。

数据库就是这个平台的「事实中枢」：身份、资金、计费、路由、审计全部落在 PostgreSQL 里。

## 1. 技术栈与迁移体系

| 项 | 说明 |
|---|---|
| 数据库 | PostgreSQL（金额用 `numeric`，幂等/不变量大量使用唯一索引、部分唯一索引、CHECK 约束、触发器） |
| ORM | drizzle-orm（`packages/db/src/schema/` 是表结构的**代码化声明**，`bigint` 列统一 `mode: 'number'`） |
| 运行时 | Bun（`jsonb` 列因此使用了自定义类型，见 §4.9） |
| 迁移 | `packages/db/migrations/` 下编号 SQL 文件（`0000_xxx.sql` …），语句之间用 `--> statement-breakpoint` 分隔，由 drizzle-kit journal 按序执行 |

**表结构有三层「真相」，读代码时注意区分：**

1. `packages/db/src/schema/*.ts` — drizzle 声明，应用代码查询用的类型来源；
2. `packages/db/migrations/*.sql` — 实际建库的 DDL（多数表的 DDL 单一真源就在这里，例如 wallet 四表、identity 七表）；
3. 个别表是**手写迁移 + drizzle 只声明列结构**的例外（`request_logs` 分区表、`voucher_blobs` raw-SQL 表）——这些表**严禁**跑 `db:generate` 生成 DDL，变更必须手写迁移。

**本套文档中 SQL 块的引用约定**：标注「迁移 NNNN 原文」的（identity 七表、ledger_operations、voucher_blobs、request_logs 换表手法）是迁移文件的真实 DDL（仅重排版）；标注「等价 DDL（由 drizzle 声明直译）」的是按当前 schema 声明翻译的**当前态**等价 SQL（建表语句分散在历史迁移中，直译保证与现状一致）。两者均不可直接当迁移执行——新变更请走 §5 流程。

## 2. 全库 53 张表地图

按领域分组，点击进入对应分册：

| 分册 | 领域 | 表（数量） |
|---|---|---|
| [01-identity.md](./01-identity.md) | 身份内核 | identity_credentials、identity_passwords、identity_oauth_links、identity_challenges、identity_totp、identity_recovery_codes、identity_session_anchors（7） |
| [02-accounts.md](./02-accounts.md) | 账号与组织 | users、admins、organizations、org_members、org_invitations、api_keys、apps（7） |
| [03-rbac.md](./03-rbac.md) | 管理后台权限 | roles、permissions、role_permissions、endpoint_permissions（4） |
| [04-wallet.md](./04-wallet.md) | 钱包复式账本 | wallet_accounts、wallet_transactions、wallet_legs、wallet_authorizations、ledger_operations（5） |
| [05-billing.md](./05-billing.md) | 计费管线 | billing_requests、billing_reservations、rate_cards、rate_card_coefficients、usage_logs、fx_rates、system_configs（7） |
| [06-commerce.md](./06-commerce.md) | 套餐·支付·资金入口 | plans、user_subscriptions、payment_orders、redeem_batches、redeem_codes、transactions、referrals、marketing_settings、reconcile_discrepancies（9） |
| [07-control-plane.md](./07-control-plane.md) | 模型与渠道控制面 | providers、channels、model_mappings、model_channels、routing_policies、channel_recharges、voucher_blobs、integration_settings（8） |
| [08-observability.md](./08-observability.md) | 日志与观测 | request_logs、trace_spans、audit_logs、generation_tasks（4） |
| [09-notifications.md](./09-notifications.md) | 告警通知 | notification_channels、notify_outbox（2） |
| [10-er-and-flows.md](./10-er-and-flows.md) | ER 总图 + 核心流程 | — |

其中 52 张定义在 drizzle schema；`voucher_blobs` 是刻意不进 drizzle 的 raw-SQL 表（DDL 在迁移 0066，原因见 07 分册）。
另外两张**分区母表**的物理分区（`request_logs_YYYY_MM`、`trace_spans` 日分区、`request_logs_default`）由 worker 定时维护，不单独建模、不计数。

## 3. 一张请求的生命周期（先建立全局感）

理解表为什么这么设计，最快的方式是先看一次「用户调用一次大模型」发生了什么：

```
用户带 API Key 请求 gateway
  │
  ├─ ① 鉴权：api_keys.key_hash（SHA-256）命中 → 找到 user / subscription
  ├─ ② 计费准入：billing_requests 落一行（status=authorized），按「资金来源瀑布」预扣：
  │      billing_reservations 逐来源记账（subscription 额度 → payg 余额）
  │      → user_subscriptions.reserved_amount / wallet in_flight 相应上涨
  ├─ ③ 路由：model_mappings（对外模型名→真实模型）× model_channels（哪些渠道能跑）
  │      × channels（渠道健康/余额/熔断状态）→ 选出渠道，渠道在途敞口 upstream_reserved 上涨
  ├─ ④ 上游调用（packages/ai 适配器），request_logs 同步记录排障日志
  ├─ ⑤ 流式/非流式拿到 usage 证据 → worker 异步结算：
  │      billing_requests → settled；usage_logs 落计费明细（价格快照+系数快照）
  │      transactions 落用户资金流水；wallet 复式账本落腿；订阅 used_amount 上涨
  └─ ⑥ 失败：预扣释放（released），渠道敞口回落；异常进 notify_outbox 告警
```

每一步涉及哪些表，在各分册里会反复对照这条主线。

## 4. 全局设计约定（新手必读）

这些约定贯穿全库，先记住它们，后面每个分册就不再重复解释。

### 4.1 金额：`numeric(38,18)`、单位「元」、字符串进出

所有钱都是 `numeric(38,18)`（38 位总精度、18 位小数），单位元（CNY）。应用层用 Decimal / 十进制字符串运算，**全链路禁止浮点**（浮点会把 0.1+0.2 算成 0.30000000000000004，资金系统不可接受）。模型单价（`*_price`）的口径是**元/百万 token**。

### 4.2 状态列：smallint 词表 + CHECK 兜底

大量表用 `smallint` 状态列（`0` 正常/有效，`1` 停用/失败，`2+` 更多态），词表常量在代码里（如 `ACCOUNT_STATUS = { ACTIVE:0, BANNED:1, DELETED:2 }`），DB 里用同名 CHECK 约束拦非法值。两边必须同步改——这是「库层挡非法值、编译层挡魔法数字」的双保险写法。多态复杂的状态机（billing_requests、wallet 等）则用 `varchar` 词表。

### 4.3 幂等：唯一索引就是幂等键

所有「绝不能重复发生」的资金动作，都靠**唯一索引 / 部分唯一索引**在 DB 层挡住：

```sql
-- 例：transactions 的扣费流水，同一笔请求只允许一条
CREATE UNIQUE INDEX transactions_consume_ref_uq
  ON transactions (ref_type, ref_id) WHERE ref_type = 'usage_logs';
```

部分唯一索引（`WHERE ...`）的妙处：只对某种业务形态去重，不影响其他行；也能实现「软删除后名称释放」（`WHERE deleted_at IS NULL`）、「每用户至多一条 active 订阅」（`WHERE status = 0`）这类结构性不变量。

### 4.4 不变量下沉：CHECK + 触发器

能在 DB 层强制的业务不变量绝不只靠应用代码，例如：

- `wallet_legs`：`balance_after = balance_before + amount`（账本链恒等，另有触发器验证连续性）；
- `user_subscriptions`：`used_amount + reserved_amount <= quota_amount`（套餐额度永不为负）；
- `usage_logs`：成功单 `amount = plan_amount + payg_amount`（金额拆分守恒）。

wallet 四表还有**提交期延迟约束触发器**（迁移 0059）：腿合计恒为 0、账本行不可 UPDATE/DELETE、账户余额与最后一腿对齐等，详见 [04-wallet.md](./04-wallet.md)。

### 4.5 软删除：`deleted_at` + 部分唯一索引

providers / channels / model_mappings 三张控制面表用「回收站」式逻辑删除：`deleted_at IS NULL` = 在册；非空 = 已删除但**记录保留**（历史计费、FK 引用可追溯），且名称唯一约束只约束在册行——删掉后可以重建同名。

### 4.6 账本类表：append-only，只增不改

`transactions`、`usage_logs`、`channel_recharges`、`fx_rates`、`wallet_transactions/legs`、`audit_logs` 都是追加式账本：错账靠新行冲正，不 UPDATE 历史行（wallet 甚至有触发器物理禁止 UPDATE/DELETE）。这是财务审计的基本盘。

### 4.7 主键形态分两类

- **业务流水/配置表**：`bigserial` 自增（users、api_keys、transactions…）；
- **请求/资金/任务域**：`uuid`（billing_requests.request_id、payment_orders.id、wallet_accounts.id、generation_tasks.id）——这些 ID 会出现在 URL、回调、跨服务日志里，uuid 天然不带顺序信息、防枚举。

### 4.8 外键（FK）的克制使用

身份域（identity_*）和钱包域（wallet_*）**刻意不做物理 FK**：`identity_*.user_id`、`wallet_accounts.user_id` 都不 REFERENCES users——身份内核业务无关、钱包是独立资金域，关联由应用层维护。计费/日志域则常规使用 FK，部分日志列用 `ON DELETE SET NULL`（如 `usage_logs.app_id`）保住计费事实不随维表删除丢失。

### 4.9 jsonb 列的自定义类型

schema 里所有 jsonb 列来自 `schema/jsonb.ts` 的**自定义类型**而非 drizzle 缺省 `PgJsonb`：Bun SQL 对「字符串参数 → jsonb 列」会把对象双重编码（上游 bug），自定义类型对驱动透传 JS 对象规避此问题。列上的 `.$type<T>()` 只影响 TS 类型，不影响存储。

### 4.10 分区表

- `request_logs`：`PARTITION BY RANGE (created_at)` 按月分区，30 天滚动删除（worker 维护）；
- `trace_spans`：按 `start_time` 日分区。
两者都是高写入量表，分区是为了让删除变成「DROP 分区」而不是「DELETE 千万行」。

### 4.11 时间列

统一 `timestamp with time zone`（`timestamptz`），默认 `now()`。语义全是 UTC 存储。

## 5. 改表的正确姿势（速查）

1. 改 `packages/db/src/schema/*.ts`（drizzle 声明）；
2. 生成迁移：`db:generate`（drizzle-kit 产出 `migrations/NNNN_*.sql`；**request_logs / voucher_blobs 例外**，必须手写）；
3. 迁移文件头部写中文注释说明「为什么」（现有 110 个迁移全部如此，是最好的历史文档）;
4. schema 变更必须配套核对：所有消费方、`architecture.test.ts`、配置测试；
5. 跑受影响 workspace 的 typecheck/test，最后跑根四门（`bun run typecheck && lint && test && build`）。

## 6. 新手词汇表

| 术语 | 含义 |
|---|---|
| PAYG | Pay As You Go，按量付费，扣用户余额 |
| 套餐额度（quota） | 包月/加油包预付的金额额度，按「官方价×系数」同口径折算扣减 |
| 席位（seats/quantity） | 团队套餐的可加份数，总额度 = 档额度 × 席位 |
| 费率卡（rate card） | 定价系数档位，用户价 = 官方价 × 系数（global/group/model 三级解析） |
| 在途敞口（in flight / reserved） | 已预扣未结算的金额；「可用额 = 余额 + 授信 − 在途」 |
| 预扣（reservation/authorize） | 请求开始前先冻结一笔预估费用，结束后按实结算 |
| 熔断（circuit break） | 渠道连续失败/余额耗尽时自动停用（status=3），冷却后恢复 |
| 复式账本（double-entry） | 每笔交易 ≥2 条腿、借贷合计为 0 的记账法，wallet 四表实现 |
| outbox（发件箱） | 与业务同事务写入的事件表，worker 异步投递，保证「事件不丢」 |
| 上游（upstream） | 平台真正的模型供应商（OpenAI 兼容端点） |
| 渠道（channel） | 供应商 × 一把上游 Key 的组合，路由与成本控制的最小单元 |
| 模型映射（model mapping） | 对外模型名 → 真实模型的定价/能力定义 |
| TTFT | Time To First Token，首字延迟 |
| OIDC | 开放身份协议；users 的 (issuer, subject) 即来自此 |
