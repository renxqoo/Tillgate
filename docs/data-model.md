# AI Gateway 数据模型设计（v0.1）

> 配套文档：`requirements.md`（业务逻辑）、`api-contract.md`（接口契约）
> 数据库：PostgreSQL。本设计覆盖一期（P0）全部表，二期预留表单独列出。

---

## 1. 设计原则

1. **金额一律「元」+ `numeric(38,18)` 高精度定点**（PostgreSQL numeric，真十进制无浮点误差），账本永不 round；仅对外结算（平台↔渠道）用银行家舍入（half-even）到分，尾差入专门科目。
2. **敏感信息加密/哈希存储**：上游供应商 Key 加密存储（AES-GCM）；虚拟 Key、充值码、client_secret 只存 SHA-256 哈希（明文仅在创建时展示一次）。
3. **计费快照**：官方价、费率卡系数在计量时快照进 `usage_logs`，历史账单不受后续改价影响。
4. **DB 为唯一权威账本**：`billing_requests` 同时保存授权、lease 与 durable receipt；Redis/BullMQ 只做唤醒，不参与资金正确性。
5. **内部 ID**：主键用 `bigserial`；对外暴露的业务 ID 带前缀（`ag_` 虚拟 Key、`app_` 应用、`req_` 请求）。
6. `usage_logs` / `request_logs` 只追加、不可修改；纠错走 `transactions` 的调账流水（审计可追溯）。
7. **对账护栏**：worker 定时跑对账作业（`reconcile.ts`），校验 `sum(usage_logs.amount)` 与余额变动一致，不平写 `reconcile_discrepancies` + 告警。

---

## 2. 计算规范（金额/费用，落地于 packages/money）

> 结论：**使用 decimal.js 任意精度十进制库**——账本全程 Decimal 运算、永不 round，杜绝浮点误差（IEEE754）与舍入资损。DB 存 `numeric(38,18)`（精度到 1e-18 元），JS 侧用 Decimal。实现集中在一个包 + 单测锁死，禁止在业务代码里散落计算。

**单位约定**：
- 金额：「元」，DB `numeric(38,18)`（全精度，不 round）
- 单价：「元 / 百万 token」（decimal，如 `0.002` = ¥0.002/百万）
- 系数：小数（如 `1.5`），`numeric(6,3)`

**计费公式（decimal 全精度，账本永不 round）**：

```
uncached = inputTokens - cachedInputTokens      // inputTokens 为总输入（含缓存命中）
base     = uncached×输入价 + cached×缓存价 + 输出×输出价
amount   = base / 1_000_000 × 系数               // 元，Decimal 全精度（不 round）
```

**防错清单**（`packages/money` 单测覆盖）：
1. 金额一律元 + Decimal，浮点（JS number）禁止参与运算（0.1+0.2 问题）
2. 账本永不 round：单次请求 1e-8 元也精确计费、入账（杜绝「真实消耗却计费 0」资损）
3. 系数为小数直接参与 Decimal 运算
4. inputTokens 含缓存命中 → 未缓存部分 = inputTokens - cachedInputTokens
5. 累加 1 万次小请求精确变动（防累积资损）
6. 异常输入（负/NaN/Infinity）→ safe() 夹到 0（绝不反向收费）
7. 对外结算边界用银行家舍入（half-even）到分，尾差入科目；账本内部零 round

**模块**：`amount.ts`（费用公式，返回 Decimal）/ `reservation.ts`（足额授权上界）/ `units.ts`（Decimal 工具）——gateway 与 worker 共用（packages/money）。

**统一资金入口**：普通资金操作使用 `createLedger()`；请求扣费只允许走 `createBilling()` 的 `authorize / signal / drain`，调用方不能直接释放预扣或提交扣费金额。

---

## 3. ER 概览

```
users (账户=用户/企业)
 ├── apps (应用: client_id/secret, 换 JWT)
 ├── api_keys (虚拟 Key)
 ├── transactions (资金流水: 充值/扣费/调账)
 ├── fund_operations (跨入口幂等收据)
 ├── usage_logs (用量明细, 计量计费)
 ├── request_logs (请求日志, 30天滚动)
 └── redeem_batches ── redeem_codes (充值码)

providers (供应商: base_url/协议)
 └── channels (渠道 = 供应商 + 上游Key)
      └── model_channels (关联表) ── model_mappings (对外模型名/真实模型/单价)
           └── api_keys ── (调用时选定)
```

---

## 3. 表结构明细

### 3.1 users — 用户/企业账户

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| issuer | varchar(64) | 身份源标识（OIDC issuer URL；本地账号固定 `local`），**唯一键 (issuer, subject)** |
| subject | varchar(255) | 身份源内唯一标识（OIDC sub / 本地账号名）——OIDC 规范中 sub 仅在 issuer 内唯一 |
| identity_provider | varchar(16) | 身份源类型：`oidc` / `local` |
| email | varchar(255) | |
| display_name | varchar(64) | |
| role | smallint | 0 普通用户 / 1 管理员（控制台权限判定） |
| balance | numeric(38,18) | 已结算余额（元）；授权期间不变，仅真实结算、充值、赠送和调账修改 |
| reserved_balance | numeric(38,18) | 所有未终结请求的处理中预留总额；可用额度 = balance - reserved_balance |
| rate_card_id | FK → rate_cards | 绑定费率卡（一期默认「标准」卡，全局系数 1.0；替换原单一倍率字段，见 3.8） |
| rpm_limit / tpm_limit | int NULL | 用户级限流，NULL=继承全局默认（tech-stack §5：默认 60 RPM / 1M TPM） |
| status | smallint | 0 正常 / 1 封禁 / 2 注销 |
| freeze_reason | varchar(128) | 封禁原因（管理员手动封禁时填，如风控；充值后自动解冻并清空。注：透支不冻结——余额为负=欠款，下次充值自动抵扣） |
| created_at / updated_at | timestamptz | |

### 3.2 apps — 应用（企业 Agent 凭证）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| app_id | varchar(32) UNIQUE | 对外 ID：`app_` + 随机 |
| user_id | FK → users | |
| client_id | varchar(64) UNIQUE | OAuth2 公共标识 |
| client_secret_hash | varchar(64) | SHA-256；明文仅创建/轮换时展示一次 |
| name / description | varchar | |
| scope | jsonb | 限制项（可选）：`{models: [...], rpm: N, tpm: N}` |
| status | smallint | 0 启用 / 1 禁用 |
| created_at / rotated_at | timestamptz | |

**JWT 即时失效机制**（关键）：
- JWT 由**网关密钥**签发，与 client_secret 无关——**轮换 client_secret 只阻止旧密钥再换新 JWT，不撤销已签发的 JWT**。
- **禁用 App**：清 Redis App 状态缓存（`app:{appId}`）→ 网关每次验签时检查该缓存 → 已签发 JWT **立即全部失效**（无需枚举 jti）。
- **单令牌紧急吊销**：jti 黑名单（Redis，TTL = 原过期时间）。

### 3.3 api_keys — 虚拟 Key

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| key_hash | varchar(64) UNIQUE | SHA-256(完整 Key)；**明文 Key 不落库**，鉴权时对请求 Key 哈希后查询 |
| key_preview | varchar(40) | 展示用：`ag_****abcd`（末 4 位），用户面板显示 |
| user_id | FK → users | |
| app_id | FK → apps NULL | 可选归属某 App |
| name / remark | varchar | |
| expires_at | timestamptz NULL | NULL=永久 |
| rpm_limit / tpm_limit | int NULL | Key 级限流，NULL=继承用户/全局 |
| status | smallint | 0 有效 / 1 吊销 |
| last_used_at | timestamptz | |
| revoked_at | timestamptz NULL | 吊销时间（审计友好） |
| created_at | timestamptz | |

### 3.4 providers — 供应商

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| name | varchar(32) UNIQUE | deepseek / openai / minimax / glm / qwen |
| protocol | varchar(32) | 一期全为 `openai_compatible` |
| base_url | varchar(255) | 上游入口（可被渠道覆盖） |
| status | smallint | 0 启用 / 1 禁用 |
| created_at | timestamptz | |

### 3.5 channels — 渠道（供应商 × 上游 Key）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| provider_id | FK → providers | |
| name | varchar(64) | |
| api_key_enc | text | AES-GCM 加密后的上游 Key（解密密钥在环境变量/密钥管理） |
| base_url_override | varchar(255) NULL | 默认取 provider.base_url |
| models | jsonb | 该渠道支持的上游模型名白名单；**NULL 或空数组 = 不限**；非空时路由取「映射渠道列表 ∩ 白名单」 |
| weight | int | 路由权重（越大被选中概率越高） |
| priority | int | 优先级（越大越先尝试） |
| status | smallint | 0 启用 / 1 禁用 / 2 维护 / 3 熔断(自动) / 4 凭据无效（连续 401/403 自动标记，更换 Key 后恢复） |
| fail_count | int | 连续失败次数（熔断判定） |
| cooldown_until | timestamptz NULL | 熔断截止时间（Redis 同步副本） |
| rpm_limit / tpm_limit | int NULL | 渠道级限流（保护上游配额） |
| created_at / updated_at | timestamptz | |

### 3.6 model_mappings — 模型映射（对外模型名 → 真实模型）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| external_name | varchar(64) UNIQUE | 对外模型名（客户端看到的） |
| real_model | varchar(128) | 上游真实模型名 |
| status | smallint | 0 上架 / 1 下架（下架后新请求拒绝） |
| input_price | numeric(38,18) | **官方**输入单价（元 / 百万 token，按供应商官方定价配置，随官方调价更新） |
| output_price | numeric(38,18) | **官方**输出单价（元 / 百万 token） |
| cache_input_price | numeric(38,18) | **官方**缓存输入单价（缓存命中计价；不启用缓存计费则与输入价同值） |
| fallback_models | jsonb NULL | fallback 模型链（对外模型名数组，配置启用；默认空 = 不降级） |
| param_rules | jsonb NULL | 参数抹平规则（透传基底，规则驱动）：`{"ignore":["temperature"],"clamp":{"max_tokens":{"max":8192}},"map":{"max_tokens":{"to":"max_completion_tokens"}},"unknown":"passthrough"}`；reasoning 模型预置；provider profile 内置默认、本字段按模型覆盖（见 ai-package.md §7.6） |
| billing_policy | jsonb NULL | 多模态报价策略 v1：仅允许 `unified_input_tokens`，声明模型请求级 `maxInputTokens` 及 image/audio/file 数量与内嵌总字节上限；策略指纹随报价/收据持久化 |
| rpm_limit / tpm_limit | int NULL | 模型级限流 |
| created_at / updated_at | timestamptz | |

**上架约束**：管理端上架模型时必须 ≥1 个可用渠道（model_channels 非空且渠道启用），否则禁止上架并在面板告警（避免 `/v1/models` 可见但调用全 503）。

### 3.7 model_channels — 映射 × 渠道 关联

| 字段 | 类型 | 说明 |
|---|---|---|
| mapping_id | FK → model_mappings | 复合主键 (mapping_id, channel_id) |
| channel_id | FK → channels | |
| weight / priority | int | 可覆盖渠道默认值（按映射微调） |

### 3.8 rate_cards — 费率卡（定价档位）

> 定价模型：**用户价 = 官方价（model_mappings）× 费率卡系数**。官方价与系数分离——官方调价只改官方价表，套餐/档位调整只改费率卡。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| name | varchar(32) | 如「标准」「快速」「套餐A」 |
| description | varchar(255) | |
| status | smallint | 0 启用 / 1 停用（停用后新请求拒绝，已签发 JWT 按快照继续） |
| created_at / updated_at | timestamptz | |

### 3.9 rate_card_coefficients — 费率卡系数

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| rate_card_id | FK → rate_cards | |
| scope | varchar(8) | `global` 全局 / `model` 按模型（二期启用） |
| model_mapping_id | FK → model_mappings NULL | scope=model 时指定 |
| coefficient | numeric(6,3) | 系数（1.0 = 按官方价原价） |
| created_at | timestamptz | |

**约束**：UNIQUE(rate_card_id, scope, model_mapping_id)；每卡必有且仅有一行 `global`（兜底系数），model 覆盖行优先。二期扩展：scope 预留 `group`（模型分组覆盖），无需改表结构。

### 3.10 usage_logs — 用量明细（只追加，长期保留）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| request_id | uuid UNIQUE | 网关内部请求 ID，天然幂等（同请求只计一次） |
| user_id | FK → users | |
| app_id / api_key_id | FK NULL | 凭证归属：app_id=归属应用（JWT 必填；Key 归属 App 时同样记录），api_key_id=具体凭证（Key 调用必填）；二选一可空 |
| credential_type | varchar(8) | `key` / `jwt` |
| external_model / real_model | varchar | 对外名 + 真实名（快照） |
| channel_id | FK → channels | 实际调用渠道 |
| input_tokens | int | 输入总 tokens（含缓存命中） |
| cached_input_tokens | int | 缓存命中输入 tokens（usage 无缓存字段时为 0） |
| output_tokens | int | 输出 tokens |
| input_price / output_price / cache_input_price | numeric(38,18) | 官方价快照（元/百万） |
| coefficient | numeric(6,3) | 费率卡系数快照（最终单价 = 官方价 × 系数；JWT 内嵌快照最长滞后 2h，属可接受设计） |
| amount | numeric(38,18) | 预付费实扣费用，不超过 reserved amount；理论金额另存 calculated_amount |
| upstream_cost | numeric(38,18) | 上游成本估算（元，官方价×实际用量快照；供应商对账数据基础） |
| plan_amount | numeric(38,18) | 套餐额度承担部分（默认 0） |
| payg_amount | numeric(38,18) | 余额承担部分（默认 0）；**status=0 时 amount = plan_amount + payg_amount** |
| billed_by | varchar(8) | `plan` / `payg` / `both`（同一请求套餐+余额混扣） |
| subscription_id | FK → user_subscriptions NULL | 套餐扣减时关联（二期启用，字段一期建表） |
| duration_ms | int | |
| status | smallint | 0 成功已计费 / 1 失败不计费 |
| stream | boolean | |
| stream_aborted | boolean | 流式提前中断；仅在仍有供应商可信 usage 时结算（见 requirements.md 5.11） |
| created_at | timestamptz | |

**索引**：`(user_id, created_at DESC)`、`(external_model, created_at)`、`(channel_id, created_at)`、`(subscription_id, created_at)`、`request_id UNIQUE`。（P2 优化：不建独立 `(created_at)` 单列索引——与复合索引重叠、纯写放大；按月分区后靠分区裁剪）

### 3.11 transactions — 资金流水（余额变化的唯一依据）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| user_id | FK → users | |
| type | varchar(16) | `consume` 扣费 / `redeem` 充值码 / `gift` 系统赠送（体验额度）/ `manual` 管理员调账 / `refund` 退款 / `subscribe` 购买套餐（二期） |
| amount | numeric(38,18) | 有符号：负=支出，正=收入（元） |
| balance_before / balance_after | numeric(38,18) | 记账时快照（元） |
| ref_type / ref_id | varchar | 来源关联（usage_logs.request_id / redeem_codes.id / 管理员） |
| remark | varchar(255) | |
| created_by | bigint NULL | 管理员操作时记录 |
| created_at | timestamptz | |

**索引**：`(user_id, created_at)`、`(type, created_at)`、`(ref_type, ref_id)`。

### 3.11b billing_requests — 请求级计费状态机（DB 权威）

| 字段 | 类型 | 说明 |
|---|---|---|
| request_id | uuid PK | 幂等键 = gateway 请求 ID（= usage_logs.request_id） |
| user_id | FK → users | |
| reserved_amount | numeric(38,18) | 足额授权金额（元，全精度） |
| status | varchar(32) | `authorized / in_flight / settlement_pending / processing / retry_wait / settled / released / uncertain / dead` |
| quote / receipt | jsonb | 授权报价快照 / 不可变成功收据（同时作为 durable outbox） |
| lease_owner / lease_expires_at | varchar / timestamptz | 上游在途租约；过期不等于可退款 |
| created_at / updated_at | timestamptz | |

**生命周期**（全部为事务内幂等状态迁移）：

```
authorized ──upstream.started──▶ in_flight ──receipt──▶ settlement_pending ──claim──▶ processing ──commit──▶ settled
                                                                                └─失败──▶ retry_wait / dead
authorized ──确认未调用上游/未交付──▶ released
in_flight ──lease 过期──▶ uncertain（可能已产生成本，绝不自动退款）
```

**为什么需要这张表**：旧实现把在途标记放 Redis（带 TTL），gateway 崩溃后标记过期但 DB 扣款
永不退还（用户余额永久损失）；同步降级结算又可能重复扣费。持久化后每个授权的状态迁移都是
DB 条件 UPDATE（防重复退还/重复扣费），任何故障窗口都能确定性恢复。

**索引**：`(user_id,status)`、`(status,next_settlement_at)`、`(status,lease_expires_at)`。

### 3.11c fund_operations — 资金操作幂等收据

| 字段 | 类型 | 说明 |
|---|---|---|
| operation_id | varchar(128) PK | HTTP Idempotency-Key、request_id 或稳定自然键 |
| kind | varchar(32) | `admin.adjust` / `admin.gift` / `signup.gift` / `redeem` |
| fingerprint | varchar(64) | 业务动作与规范化 payload 的 SHA-256 指纹 |
| transaction_id | bigint NULL | 首次成功写入的资金流水 ID |
| result | jsonb NULL | 首次提交的领域收据（金额、前后余额、流水 ID） |
| created_at | timestamptz | |

事务开始先插入收据占位：同 `operation_id` 且同 `kind + fingerprint` 返回首次结果，
不同 payload 返回 `idempotency_conflict`；余额和流水任一步失败时占位随事务回滚。
这保证 HTTP 重试、并发首次赠送和兑换重放都不会重复加扣余额。

### 3.12 redeem_batches / redeem_codes — 充值码

**redeem_batches**（批次）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| name / remark | varchar | |
| amount | numeric(38,18) | 统一面额（元）；**创建后不可修改**（改价需新建批次） |
| total / used_count | int | 生成数 / 已兑换数 |
| created_by | FK → users | 管理员 |
| created_at | timestamptz | |

**redeem_codes**（码）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| batch_id | FK → redeem_batches | |
| code_hash | varchar(64) UNIQUE | SHA-256；明文生成时下发 |
| status | smallint | 0 未用 / 1 已用 / 2 作废 |
| used_by / used_at | FK / timestamptz NULL | |
| expires_at | timestamptz NULL | NULL=永久有效 |

兑换流程（单事务）：claim `fund_operations` → 条件更新兑换码 → 增加批次 `used_count` → 增加余额 → 写 `transactions(redeem)` → 解除 `bad_debt` 冻结 → 保存幂等收据；任一步失败全部回滚。

### 3.13 request_logs — 请求日志（30 天滚动）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| request_id | uuid | 关联 usage_logs |
| user_id / api_key_id | FK NULL | |
| method / path | varchar | |
| status_code | int | 响应状态 |
| error_code | varchar NULL | 网关错误码（见 API 契约） |
| duration_ms | int | |
| request_summary | jsonb NULL | 截断后的请求摘要（不含敏感内容） |
| attempts | int | 尝试渠道次数（排障/观测用） |
| candidates_tried | jsonb NULL | 尝试过的候选列表（渠道/模型与结果，排障用） |
| created_at | timestamptz | |

**按月 RANGE 分区**，定时任务删除 30 天前分区。索引：`(created_at)`、`(user_id, created_at)`。

### 3.14 audit_logs — 管理操作审计

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| admin_id | FK → users NULL | 操作人；系统任务（对账/赠送/自动冻结）为 NULL |
| actor | varchar(8) | 操作方：`admin` / `system` |
| action | varchar(64) | 如 `channel.update` / `user.adjust` |
| target_type / target_id | varchar | |
| detail | jsonb | 变更前后摘要 |
| created_at | timestamptz | |

### 3.15 二期表：plans / user_subscriptions（套餐与订阅，二期实现、一期建表）

**plans**（套餐定义）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| name | varchar(32) | |
| price | numeric(38,18) | 售价（元） |
| period_days | int | 周期天数（30 / 365） |
| quota_amount | numeric(38,18) | 金额额度（元，按「官方价×系数」折算扣减，与按量同口径） |
| fallback_to_balance | boolean | 额度耗尽后是否允许用余额（默认 true，套餐级开关） |
| status | smallint | 0 启用 / 1 停用 |

**user_subscriptions**（用户订阅）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| user_id | FK → users | |
| plan_id | FK → plans | |
| start_at / end_at | timestamptz | 生效期 |
| quota_amount | numeric(38,18) | 额度快照（元） |
| used_amount | numeric(38,18) | 已用额度（元，原子扣减，同余额模式） |
| status | smallint | 0 有效 / 1 到期 / 2 取消 |
| created_at | timestamptz | |

**计费判定（套餐额度优先，余额兜底）**：见 requirements.md 4.9；单请求可同时扣套餐额度与余额（usage_logs.billed_by=both）。

### 3.16 二期预留表（本期不建）

- **payment_orders**：在线支付订单 — user_id、amount、status、channel、pay_url、paid_at
- **daily_stats**：聚合表（报表加速）— user_id、date、model、requests、input_tokens、output_tokens、cost，worker 每日聚合

---

## 4. Redis 数据结构（缓存/热路径）

| Key | 类型 | 用途 | TTL |
|---|---|---|---|
| （无余额缓存） | — | 余额与 billing_requests 权威在 DB，Redis 不参与资金正确性 | — |
| `quota:{subId}` | string | 套餐剩余额度缓存（原子扣减，同 bal 模式） | 订阅有效期 |
| `sub:{userId}` | string | 有效订阅缓存（鉴权阶段判定有无套餐） | 订阅有效期 |
| `auth:{keyHash|jti}` | string | 凭证→用户上下文缓存（降低 DB 查询） | 与凭证有效期一致 |
| `rl:user:{id}:rpm:{win}` 等 | zset/string | 限流计数（维度：user/key/model/channel/global） | 窗口长度 |
| `cooldown:{channelId}` | string | 熔断截止时间戳 | 熔断时长 |
| `jti:{jti}` | string | JWT 吊销黑名单 | exp - now |
| `billing-settlement` | BullMQ 队列 | 只携带 requestId 的结算唤醒；DB sweeper 是可靠恢复路径 | 失败任务保留 |
| `lock:*` | string | 分布式锁（充值码兑换防重等） | 秒级 |

---

## 5. 企业预付费一致性流程

```
授权阶段（gateway，DB 事务）：
  估算上限 = (估算输入 tokens×输入价 + 默认输出上限×输出价)×系数（缓存按全价保守估）
  候选定价 = max(主模型估算, 各 fallback 模型估算)  ← 预扣按最贵候选，杜绝 fallback 更贵导致结算透支
  required = max(主模型与 fallback 的完整费用上限)
  required > BILLING_RESERVATION_MAX ──▶ 拒绝并要求降低输出上限
      │
      ▼
  事务：INSERT billing_requests(authorized) +
        UPDATE users SET reserved_balance=reserved_balance+required
        WHERE balance-reserved_balance >= required（不足原子回滚 → 402）
  授权不修改已结算 balance；用户端余额不随预留上下跳动
  调用上游前转 in_flight；长流定时续 lease；单渠道失败不释放请求级授权
      │
      ▼
成功与结算：
  amount = (未缓存输入×输入价 + 缓存输入×缓存价 + 输出×输出价)/1e6 × 系数（Decimal 全精度，快照计价）
  gateway 先提交 receipt 并转 settlement_pending，之后才返回非流 2xx/关闭 SSE；
  BullMQ 只发送 requestId，失败时 DB sweeper 扫描恢复。结算事务：
    INSERT usage_logs ON CONFLICT(request_id) DO NOTHING → 冲突 = 已结算，幂等跳过
    actual <= reserved_amount 才允许精确结算；actual > reserved_amount 进入 dead 审核并触发配置止损，禁止静默封顶少扣
    原子结算：balance = balance - charged；reserved_balance -= reserved_amount；状态转 settled
    写 transactions(consume, -amount, 快照前后余额)
  事务外（best-effort）：TPM 分钟桶回填（未缓存输入 + 输出，仅首次结算）
      │
      ▼
失败与恢复：只有确认整个请求未交付时才能 released；authorized 过期且从未调用上游可退款；
in_flight 过期只能转 uncertain 并告警/人工复核。
      │
      ▼
对账任务（每小时，ledger.reconcileAll）：
  Σ transactions(收入+支出) == Σ users.balance 净增减（容差 1e-9 元）
  Σ usage_logs.amount == Σ transactions(consume) 绝对值
  Σ usage_logs.upstream_cost ↔ 供应商账单核对（对账数据基础）
  不一致 → 写 reconcile_discrepancies + 告警

  对账口径：balance == Σ transactions 净额；
  reserved_balance == sum(billing_requests 未终态 reserved_amount)；两者分别核对

**性能注意**：单用户余额行是热点——worker 按 user 聚合批量结算可降低行锁竞争（当前实现
逐条结算，聚合为后续优化项）。
## 6. 二期预留设计说明

- **套餐计费**：通过 `plans` + `user_subscriptions` 实现「额度扣减」而非「金额扣费」；`usage_logs` 已预留 `subscription_id` / `plan_amount` / `payg_amount` / `billed_by`（plan/payg/both）字段，二期启用套餐无需迁移。
- **报表加速**：P1 加 `daily_stats` 聚合表，由 worker 按天聚合写入，管理端报表读聚合表，明细仍可下钻 `usage_logs`。
- **请求日志分区**：P1 起按月分区，保留策略做成配置项。
