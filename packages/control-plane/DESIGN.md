# control-plane 设计基线（DESIGN.md）

> 状态：定稿
> 总纲：[docs/project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3（包职责表）、§5（依赖方向）、P4.2（控制面配置波次）
> 施工图：[IMPLEMENTATION.md](./IMPLEMENTATION.md) ｜ 行为规格与迁移矩阵：[MIGRATION.md](./MIGRATION.md)

---

## 1. 问题域

**管理**：Provider / Channel / Model（映射与绑定）/ RateCard / 目录汇率（fx）/ 多源模型目录（catalog）的配置管理——
即「控制面配置」的全部写路径与配套读路径，外加渠道运营资金（进货/调账，含幂等）与上游连通性探针。

**不处理（显式归属）**：

| 不处理的事                                                   | 归属                      | 说明                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 管理员登录凭据 / 2FA / 会话                                  | `identity`（admin realm） | §3.4：管理员资料、状态、角色归本包，登录凭据与 MFA 归 identity；旧仓 `auth.service` 全部属凭据域。旧仓不存在「管理员资料 CRUD」用例（邀请制造号在凭据链路里），故本包 v1 **无 admins 单元**——不造无调用方的接口（铁律 4），identity 波次一并落 |
| 可执行协议 / vendor 档案词表                                 | `ai`                      | 本包经 `ports/capabilities` 接收词表快照做校验，不 import `ai`（§4.5）                                                                                                                                                                         |
| 路由候选 / 死凭据落库 / 预算守卫扣减 / 任务渠道 / 在架目录读 | `inference`（P4.4）       | 网关热路径读模型属消费侧；本包只提供配置管理写路径与探针专用读。`findRouteCandidates`/`listEnabledModels`/`loadRateCardCoefficients`/`fx.current` 网关语义、`markDeadCredential`、预算守卫 UPDATE 族在 inference 波次以消费方 port 落地        |
| 审计事实的存储 / 查询 / 保留                                 | `observability`           | 本包拥有 audit action 与 payload 语义，经 `ports/audit-sink` 发出（§3.4）；价格溯源读（`listCatalogPriceHistory`）暂以 `ports/audit-store` 只读承载，observability 落地后改经其 facade                                                         |
| 用户业务数据（余额/费率卡绑定的用户资料）                    | `accounts`                | 费率卡「卡内用户列表」与删除绑定守卫只读 `users` 表（跨域只读，accounts 波次后改经 facade）                                                                                                                                                    |
| 上游用量账本                                                 | `billing`                 | 渠道列表富化「累计消耗」只读 `usage_logs` 聚合（跨域只读）                                                                                                                                                                                     |

## 2. 外部契约

### 2.1 facade

```ts
createControlPlane(env: ControlPlaneEnv): ControlPlane
```

`ControlPlaneEnv`（装配必填，零缺省——铁律 3）：

| 项                                           | 类型                                               | 来源                                                                                 |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `db`                                         | `Db`（@tillgate/db）                              | app assembly                                                                         |
| `txRetryPolicy`                              | `TxRetryPolicy`                                    | app config（v1 等价值 = 5 / 15ms / 20ms）                                            |
| `cipher`                                     | `SecretCipher`                                     | `runtime.createCipher(ENCRYPTION_KEY)`（结构兼容）                                   |
| `capabilities`                               | `ProviderCapabilities`                             | assembly 从 `ai` 取 `SUPPORTED_PROTOCOLS` + vendor 名录注入                          |
| `probe`                                      | `UpstreamProbe`                                    | assembly 用 `ai.createAi` 包装（每次新建实例——内存态隔离）                           |
| `audit`                                      | `AuditSink`                                        | postgres 适配器（默认）或 observability 桥（仅降级清单内运营事件，§4）               |
| `auditTx`                                    | `AuditTxSink`                                      | postgres 事务参与实现（默认）——资金/费率审计与业务同事务（§4）                       |
| `voucherStorage`                             | `VoucherStorage`                                   | postgres 适配器（voucher_blobs）                                                     |
| `sources`                                    | `readonly CatalogSource[]`                         | 经 `./composition` 子入口注入（§5.3）：`[createOpenRouterSource(), modelsDevSource]` |
| `cache`                                      | `CatalogCache`                                     | 内存实现（可换共享缓存）                                                             |
| `importMaxChannels`                          | `number`                                           | 装配注入（v1 = 200）                                                                 |
| `catalogTtlMs`                               | `number`                                           | 目录源缓存 TTL                                                                       |
| `catalogChannelRpm` / `catalogChannelBudget` | `number` / `string`                                | 导入建渠道护栏预填                                                                   |
| `fx`                                         | `{ sourceUrl; autoTtlMs; fetchTimeoutMs; fetch? }` | fx 拉取参数（fetch 可注入——测试）                                                    |
| `now?`                                       | `() => Date`                                       | 时钟（测试注入；缺省 real）                                                          |

`ControlPlane` 返回面按单元分组（providers/channels/models/rates/fx/catalog），只暴露用例函数与结果类型；
不泄漏 `Db`/`DbTx`/drizzle 行类型/供应商 SDK（§5 硬约束）。

### 2.2 调用上下文

```ts
interface ControlContext {
  requestId: string;
  actor: Actor;
} // actor = admin/user/system（审计归属唯一来源）
```

用例入参统一 `{ ctx, ...input }`；`adminId` 从 `actor` 派生（`actor.kind === 'admin'`），不再散落单参。

### 2.3 错误目录（§11：能力包自有目录，命名空间 `control_plane`）

| key                                      | category        | 触发                                                                                |
| ---------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `invalid_provider_input`                 | invalid_input   | name 长度/baseUrl 形状/status 域                                                    |
| `invalid_protocol` / `invalid_vendor`    | invalid_input   | 词表外协议/档案（capabilities 注入词表校验）                                        |
| `provider_not_found`                     | not_found       | 更新/退役 miss                                                                      |
| `provider_exists`                        | conflict        | 重名（唯一索引翻译，替代 v1 泛化 409）                                              |
| `invalid_channel_input`                  | invalid_input   | name/apiKey/baseUrl override/限流域                                                 |
| `channel_not_found`                      | not_found       | 更新/退役/探针 miss                                                                 |
| `channel_exists`                         | conflict        | 重名（创建/import 兜底）                                                            |
| `import_empty` / `import_limit_exceeded` | invalid_input   | 批量导入空/超上限                                                                   |
| `insufficient_budget`                    | quota_exhausted | 调账后为负守卫                                                                      |
| `operation_conflict`                     | conflict        | 幂等键同键异参                                                                      |
| `invalid_operation_id`                   | invalid_input   | 幂等键形状非法                                                                      |
| `invalid_voucher` / `voucher_too_large`  | invalid_input   | 凭证 MIME 白名单/大小                                                               |
| `invalid_model_input`                    | invalid_input   | 价格数值域（`1e999`/`1e21`/contextLength 域）、pricingUnit 词表、billingConfig 形状 |
| `model_not_found`                        | not_found       | 更新/退役/绑定/探针 miss                                                            |
| `model_exists`                           | conflict        | externalName 重名（回执带 id 与状态）                                               |
| `free_price_conflict`                    | invalid_input   | isFree=true 必须全零价（创建直判/更新合并判）                                       |
| `invalid_coefficient`                    | invalid_input   | 系数域 0.001–9.999 且 ≤3 位小数                                                     |
| `rate_card_not_found`                    | not_found       | 更新/删除/健康 miss                                                                 |
| `rate_card_in_use`                       | conflict        | 删除时有用户绑定                                                                    |
| `invalid_fx_rate` / `invalid_fx_buffer`  | invalid_input   | 汇率 0.01–1000 / 点差 0–50                                                          |
| `fx_fetch_failed`                        | unavailable     | ECB 源非 2xx                                                                        |
| `catalog_source_not_found`               | not_found       | 未知源 id                                                                           |
| `catalog_source_unreachable`             | unavailable     | 源拉取失败（带源名与底层原因）                                                      |
| `catalog_empty`                          | invalid_input   | 导入未选模型                                                                        |
| `catalog_api_key_required`               | invalid_input   | 首次建渠道缺平台 key                                                                |
| `external_name_conflict`                 | conflict        | 目录导入外部名被异真实模型占用                                                      |

消息一律英文；中文进目录 `zh` 字段由 face 渲染（铁律 18）。

### 2.4 端口（真实边界，全部装配注入）

| port                                                             | 边界理由                                                                   | 默认实现                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| `ProviderCapabilities`                                           | 词表单一真相在 `ai`，反向依赖被 §5.2 禁止                                  | assembly 注入              |
| `UpstreamProbe`                                                  | 探针执行依赖 `ai` 装配（隔离实例）                                         | assembly 注入              |
| `SecretCipher`                                                   | 密钥属装配秘密（ENCRYPTION_KEY）                                           | `runtime.createCipher`     |
| `CatalogCache`                                                   | 目录源缓存（进程内 TTL；未来可共享）                                       | `createMemoryCatalogCache` |
| `AuditTxSink`                                                    | 资金/安全类审计事务参与 port（§5.4/G3）：写入失败随业务事务回滚            | adapters/postgres          |
| `AuditSink`                                                      | 审计存储归 observability；降级清单内运营事件 = 提交后 best-effort（见 §4） | adapters/postgres          |
| `VoucherStorage`                                                 | 凭证字节 I/O（DB bytea，后续可切 OSS）                                     | adapters/postgres          |
| `CatalogSource`                                                  | 多源目录适配契约（fetch + map + 源护栏）                                   | adapters/model-sources ×2  |
| `*Store`（provider/channel/model/rate-card/fx/audit/operations） | PostgreSQL 可替换本地依赖（§5.6 类型 2），事务句柄经 port 流动             | adapters/postgres          |

store 写方法首参 `tx: DbTx`（事务由 application 持有——§1 总纲第 8 条）；读方法无句柄（实现自持池）。
`DbTx` 类型只出现在 port/adapter 签名与 application 事务体内，**不进 facade 返回面**。

## 3. 关键语义（与 v1 行为等价的判定基准）

1. **密钥生命周期**：明文只在加密前/解密后内存存在；落库恒 `enc:v1` 密文；一切返回体/列表不带密文与明文；
   换 Key = 重加密 + 复位运行态（status→0 / failCount→0 / cooldownUntil→null）；探针回显仅 `maskUpstreamKey`（首 4 + `****` + 尾 4）。
2. **fx 生效口径**：真相在 `fx_rates` 追加表（只增不改）+ 审计；`system_configs['catalog_fx']` 只是缓存视图。
   base = override（最近 manual 行）?? 最近 auto 行；effective = base ×(1+buffer/100)（override 态不叠点差）；
   usage 收据快照 base（本包只管口径，不快照）。
3. **费率卡**：用户价 = 官方价 × 系数；每卡恰一 global 兜底行（建卡同拍写；`ensureGlobalCoefficient` 回填 1.000）；
   PATCH coefficient 只碰 scope='global' 行（M1 回归点）；删除前置无用户绑定。
4. **目录**：货架在内存（缓存 TTL）；导入落既有 provider/channel/model_mappings 三层，单事务整体成败；
   channel 源 find-or-create + 上架，reference 源落草稿 status=1 不建渠道、重复 skip；
   isFree 由价格全零推导；USD 预填 = 目录价 × effective（服务端重算 provenance 进审计全链）。
5. **渠道资金**：幂等（`ledger_operations` 占位→执行→回执；同键同参重放回执、同键异参冲突）；
   进货熔断自动复活（status 3→0）；调账守卫 = 调后非负。
6. **审计（§5.4/G3，2026-08-23 收口）**：双形态——**资金/费率类审计（channel.recharge/
   channel.adjust/rate_card.update）经 `AuditTxSink` 事务参与 port 与业务同事务写入**，失败随
   事务回滚（审计与变更原子；费率审计 before/after 都进 detail）；**低价值运营事件**
   （provider/channel/model 建档改档、目录导入、fx 配置）保留 v1 提交后 best-effort 语义
   （失败记日志不反噬业务；降级清单见 IMPLEMENTATION.md §6）。幂等重放不重复审计（dedupe 单事实）。

## 4. 并发与性能预算

- 探针/导入等管理面操作无热路径预算；fx 拉取 10s 超时、目录源拉取 15s 超时、auto 拉取节奏 4h TTL 懒检查（均为注入参数）。
- 批量导入 best-effort 逐条事务，单条失败不中断批次（全败才拒绝）；目录导入单事务（要么全有要么全无）。
- 列表富化（boundModels / upstreamConsumed / channelIds）仅对当前页 id 集合做两次下推聚合——不在 JS 侧循环打表。
- `runTx` 重试策略必填注入（v1 等价值 5/15/20）；幂等键冲突依赖唯一索引等待语义（并发同键第二个 INSERT 阻塞至首个事务终结）。

## 5. 依赖白名单（§5.1 执行）

```
control-plane → @tillgate/errors, @tillgate/db（事务句柄/schema,仅 ports/adapters/application 事务体）
domain 子树 → 仅 errors + decimal.js（纯计算）
application → 本包 domain/ports（+ db 的 runTx/DbTx 事务原语）
adapters → db + node:crypto（voucher 键）;不依赖 runtime/http/ai
```

禁止：`http`（协议层）、`ai`（词表经 port 注入）、`runtime`（cipher 结构兼容，无需 import）、任何 app。
