# AI Gateway 数据模型设计（v0.1）

> 配套文档：`requirements.md`（业务逻辑）、`api-contract.md`（接口契约）
> 数据库：PostgreSQL。本设计覆盖一期（P0）全部表，二期预留表单独列出。

---

## 1. 设计原则

1. **金额一律「元」+ `numeric(38,18)` 高精度定点**（PostgreSQL numeric，真十进制无浮点误差），账本永不 round；仅对外结算（平台↔渠道）用银行家舍入（half-even）到分，尾差入专门科目。
2. **敏感信息加密/哈希存储**：上游供应商 Key 加密存储（AES-GCM）；虚拟 Key、充值码、client_secret 只存 SHA-256 哈希（明文仅在创建时展示一次）。
3. **计费快照**：官方价、费率卡系数在计量时快照进 `usage_logs`，历史账单不受后续改价影响。
4. **DB 为唯一权威账本**：余额权威在 DB（`users.balance` + `transactions` 流水驱动），不再用 Redis 缓存余额；预扣（hold）走 DB 条件 UPDATE + 行锁防并发超卖，Redis 仅存 hold 在途标记（reclaim 兜底用）。
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

**模块**：`amount.ts`（费用公式，返回 Decimal）/ `hold.ts`（预扣估算）/ `quota.ts`（套餐额度扣减 + 预扣对账）/ `units.ts`（Decimal 工具 + toCents 结算边界）——gateway 与 worker 共用。

---

## 3. ER 概览

```
users (账户=用户/企业)
 ├── apps (应用: client_id/secret, 换 JWT)
 ├── api_keys (虚拟 Key)
 ├── transactions (资金流水: 充值/扣费/调账)
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
| balance | numeric(38,18) | 余额（元），权威账本字段，只允许通过结算事务原子修改（预扣/补扣/退款，见第 5 节） |
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
| tokens_estimated | boolean | usage 缺失时按估算（估算结果全部按未缓存输入计） |
| input_price / output_price / cache_input_price | numeric(38,18) | 官方价快照（元/百万） |
| coefficient | numeric(6,3) | 费率卡系数快照（最终单价 = 官方价 × 系数；JWT 内嵌快照最长滞后 2h，属可接受设计） |
| amount | numeric(38,18) | 费用（元）= (未缓存输入×输入价 + 缓存输入×缓存价 + 输出×输出价)/1e6 × 系数，Decimal 全精度不 round；status=0 时 = plan_amount + payg_amount（实扣，余额可为负=欠款） |
| upstream_cost | numeric(38,18) | 上游成本估算（元，官方价×实际用量快照；供应商对账数据基础） |
| plan_amount | numeric(38,18) | 套餐额度承担部分（默认 0） |
| payg_amount | numeric(38,18) | 余额承担部分（默认 0）；**status=0 时 amount = plan_amount + payg_amount** |
| billed_by | varchar(8) | `plan` / `payg` / `both`（同一请求套餐+余额混扣） |
| subscription_id | FK → user_subscriptions NULL | 套餐扣减时关联（二期启用，字段一期建表） |
| duration_ms | int | |
| status | smallint | 0 成功已计费 / 1 失败不计费（一期仅 0/1；透支如实扣全额，余额可为负=欠款，不单列坏账状态） |
| stream | boolean | |
| stream_aborted | boolean | 流式提前中断（客户端断开/上游中途失败），按已收内容估算计费（见 requirements.md 5.11） |
| created_at | timestamptz | |

**索引**：`(user_id, created_at DESC)`、`(external_model, created_at)`、`(channel_id, created_at)`、`(subscription_id, created_at)`、`request_id UNIQUE`。（P2 优化：不建独立 `(created_at)` 单列索引——与复合索引重叠、纯写放大；按月分区后靠分区裁剪）

### 3.11 transactions — 资金流水（余额变化的唯一依据）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| user_id | FK → users | |
| type | varchar(16) | `consume` 扣费 / `redeem` 充值码 / `gift` 系统赠送（体验额度）/ `manual` 管理员调账 / `refund` 退款 / `subscribe` 购买套餐（二期） |
| amount | bigint | 有符号：负=支出，正=收入 |
| balance_before / balance_after | bigint | 记账时快照 |
| ref_type / ref_id | varchar | 来源关联（usage_logs.request_id / redeem_codes.id / 管理员） |
| remark | varchar(255) | |
| created_by | bigint NULL | 管理员操作时记录 |
| created_at | timestamptz | |

**索引**：`(user_id, created_at)`、`(type, created_at)`、`(ref_type, ref_id)`。

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

兑换流程（事务）：`UPDATE redeem_codes SET status=1, used_by=?, used_at=now() WHERE id=? AND status=0 [AND (expires_at IS NULL OR expires_at>now())]` → 影响行数=1 才成功 → 写 transactions(redeem) + 余额增加 + 解冻。

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
| `bal:{userId}` | string | 余额缓存（鉴权阶段检查用，DB 为权威） | 长期（扣费/充值时同步更新） |
| `hold:{reqId}` | string | 预扣明细（userId + hold 金额）；TTL 到期未结算 → 自动释放 + 告警 | 10 分钟 |
| `quota:{subId}` | string | 套餐剩余额度缓存（原子扣减，同 bal 模式） | 订阅有效期 |
| `sub:{userId}` | string | 有效订阅缓存（鉴权阶段判定有无套餐） | 订阅有效期 |
| `auth:{keyHash|jti}` | string | 凭证→用户上下文缓存（降低 DB 查询） | 与凭证有效期一致 |
| `rl:user:{id}:rpm:{win}` 等 | zset/string | 限流计数（维度：user/key/model/channel/global） | 窗口长度 |
| `cooldown:{channelId}` | string | 熔断截止时间戳 | 熔断时长 |
| `jti:{jti}` | string | JWT 吊销黑名单 | exp - now |
| `bull:meter` | BullMQ 队列 | 计量队列（gateway 推 → worker 消费；重试/背压/并发控制由 BullMQ 提供，与 tech-stack.md 选型一致） | 消息保留 7 天 |
| `lock:*` | string | 分布式锁（充值码兑换防重等） | 秒级 |

---

## 5. 计费一致性流程（预扣模式 billing hold）

```
预扣阶段（gateway，Redis 原子 Lua，低延迟）：
  估算上限 = (估算输入 tokens×输入价 + 默认输出上限×输出价)×系数（缓存按全价保守估）
  hold = min(估算上限, 可用余额, HOLD_MAX)
  可用余额 = bal 缓存（已扣其他进行中请求的 hold）
  hold ≤ 0 ──▶ 402 insufficient_balance（不发往上游）
      │
      ▼
  Lua 原子：bal -= hold；SET hold:{reqId} {userId, amount=hold} EX 600
  转发上游 → 返回响应 → 计量事件推入 bull:meter（含 request_id 幂等键）
      │
      ▼
结算阶段（worker，事务）：
  amount = (未缓存输入×输入价 + 缓存输入×缓存价 + 输出×输出价)/1e6 × 系数，四舍五入到厘（快照计价，不受后续调价影响）
  计费判定（套餐额度优先，余额兜底，见 requirements.md 4.9）：
    有有效订阅（quota 剩余 > 0）→ plan_amount = min(amount, 剩余额度)，原子扣减订阅额度
       剩余 = amount - plan_amount：
         开关开 且 余额足 → 余额侧结算 payg_amount = 剩余（billed_by=both）
         开关关 / 余额不足 → 剩余记坏账（usage_logs status=2，网关承担）
    无订阅 → payg_amount = amount（billed_by=payg）
  余额结算（对 payg_amount，与 hold 对账）：
    **允许负余额模型**：实际用量如实扣全额（上游已执行，成本真实发生），余额可为负 = 用户欠款。
    payg_amount > hold → 补扣：UPDATE users SET balance = balance - (payg_amount - hold)（无条件，可扣成负数）
    payg_amount ≤ hold → 退款：UPDATE users SET balance = balance + (hold - payg_amount)
    扣后余额 < 0 → 标 overdraft=true（告警/催收），下次请求 hold 阶段因余额为负自然拒绝（阻断后续消费）
    下次充值 → balance += 充值额，自动抵扣负数欠款（无需额外坏账处理/冻结）
    成功 → 写 usage_logs(0) + transactions(consume, 实际金额, 快照前后余额，Δ=amount)
  删除 hold:{reqId}，刷新 bal 缓存 = DB 值
      │
      ▼
hold 超时兜底（TTL 到期未结算）：
  释放脚本必须 Lua 原子：先 GET hold:{reqId}——存在才 bal += hold 并 DEL，已不存在则不动
  （防「结算已扣费但 DEL 失败」时误释放导致余额缓存虚高）
  释放后告警 → 人工核查（计量事件丢失，从 request_logs 兜底重放，P1）
      │
      ▼
对账任务（每日）：
  Σ usage_logs.amount WHERE status=0 == Σ transactions(consume).amount == Σ users.balance 净增减
    （每条 status=0 行都有对应 consume 流水且 amount=balanceBefore-balanceAfter；透支行也如实扣，余额为负，无特例）
  Σ usage_logs.upstream_cost ↔ 供应商账单核对（对账数据基础）
  不一致 → 告警 + 人工核查

**性能注意**：单用户余额行是热点——worker 按 user **聚合批量结算**（多条明细合并一次 UPDATE），降低行锁竞争与 DB 往返；聚合时 transactions.balance_before/after **按批快照**（批内明细行同值）。
```

---

## 6. 二期预留设计说明

- **套餐计费**：通过 `plans` + `user_subscriptions` 实现「额度扣减」而非「金额扣费」；`usage_logs` 已预留 `subscription_id` / `plan_amount` / `payg_amount` / `billed_by`（plan/payg/both）字段，二期启用套餐无需迁移。
- **报表加速**：P1 加 `daily_stats` 聚合表，由 worker 按天聚合写入，管理端报表读聚合表，明细仍可下钻 `usage_logs`。
- **请求日志分区**：P1 起按月分区，保留策略做成配置项。
