# @tokenlens/inference 迁移实现文档（施工图）

> 状态：已完成（2026-08-23 核销，见 §6 实施记录）
> 设计基线见 [DESIGN.md](./DESIGN.md)；行为规格与测试迁移矩阵见 [MIGRATION.md](./MIGRATION.md)。

---

## 0. 原则

- 旧仓代码是行为语义参考（`/Users/wrr/work/ai-getway`），迁移 = 语义重写不是复制粘贴（铁律 6）；
  v1 的 `ai` 内熔断/死凭据注入存储已被 v2 `ai` 移除，本包以 AiEvent 订阅者重建（DESIGN C4）。
- 一动词一文件、工厂闭包不用 class 捕获依赖（铁律 5）；测试平铺 `__test__/`（铁律 14）；
  错误目录 `inference.*`（铁律 18 / §11）。

## 1. 审计结论（引用老仓证据，详见 MIGRATION.md §2）

- **B1 双死凭据阈值**（run-chat 即刻落库 vs tracker 3 连）：裁决 = 单阈值状态机（C3），永久拉黑移交 control-plane。
- **B2 熔断键 `protocol://host` 共享**：保留（v2 ai 事件只携带 channelKey，键单一真相对齐）；文档记录。
- **B3 非流式结算耗尽后预留滞留至租约到期**：保留 v1 语义（recover 兜底归 billing/worker 未来波次）。
- **B4 租约续期上限 100（约 8h）**：保留（有界损失设计）。
- **B5 `void authorization` 快照丢弃**：结构性消除——`BillingPort.authorize` 返回 void，快照属 billing 面。
- **B6 候选×渠道尝试无总数上限**：保留 v1（不新增未裁决的 cap）。
- **B7 死凭据告警 dedupeKey 含时间戳击穿去重**：随 markDead 移交 control-plane 消亡，不在本包复刻。
- **B8 渠道/凭证限流与 TPM 归 app**：`admitChannel` 钩子保留注入点，缺省放行（v1 单副本形态同款）。
- **B9 上下文溢出告警订阅**（v1 overflow-alert）：归 observability/control-plane 波次，本包不迁。
- **B10 usage 事件/`success.model` 声明未发**（v2 ai 现状）：消费面只用终态 `success`/`failed`/`first_chunk`
  三个已保证事件，不依赖未实现事件。
- **B11（v2 实施期缺陷）health 双状态机同键踩踏**：初版 `channel-health` 将熔断与死凭据指向同一存储键，
  两种状态 JSON 形状互相覆盖——v1 以双前缀规避的坑在重写中复现；修复 = 机器级键前缀
  `breaker:`/`credential:`（结构约束），回归用例 `channel-health.test.ts`「B11 回归」按铁律 16 命名。

## 2. 逐模块裁决表（旧 → 新）

| 旧文件（ai-getway）                                                                                         | 裁决                                                      | 新位置                                              |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| apps/gateway/src/routing/schedule.ts                                                                        | 复制                                                      | src/domain/routing/schedule.ts                      |
| apps/gateway/src/routing/switchable.ts                                                                      | 重写（词表换 ai ErrorKind 封闭词表 + 内部拒绝码）         | src/domain/routing/switchable.ts                    |
| apps/gateway/src/routing/resolve-channels.ts                                                                | 重写（repo 排序 → 加权调度内联候选循环）                  | src/application/failover.ts                         |
| apps/gateway/src/pipeline/output-cap.ts                                                                     | 复制+微修（保守上界去 bpe 入参，C1）                      | src/domain/model/output-cap.ts                      |
| apps/gateway/src/pipeline/receipt.ts                                                                        | 复制+微修（fx 移除 C2；stream 字段外提）                  | src/domain/usage/receipt.ts                         |
| packages/domain/src/rating/types.ts（归属部分）                                                             | 复制（ESTIMATE_ATTRIBUTIONS/streamEstimateAttribution）   | src/domain/usage/attribution.ts                     |
| packages/domain/src/rating/measurement.ts                                                                   | 复制（计量语义归 usage，价格运算留 billing）              | src/domain/usage/measurement.ts                     |
| packages/ai/src/breaker/breaker.ts                                                                          | 重写（class→工厂闭包；存储经 HealthStore port）           | src/health/breaker.ts                               |
| packages/ai/src/dead-credential/tracker.ts                                                                  | 重写（同上）                                              | src/health/dead-credential.ts                       |
| （v1 无：健康装配/订阅）                                                                                    | 新写（AiEvent 订阅者 + fire-and-forget）                  | src/health/channel-health.ts                        |
| apps/gateway/src/pipeline/run-chat.ts                                                                       | 重写（限流/OTel 剥离；见 failover/chat/stream）           | src/application/{quote,failover,chat,stream}.ts     |
| apps/gateway/src/pipeline/attempt-nonstream.ts                                                              | 重写                                                      | src/application/chat.ts                             |
| apps/gateway/src/pipeline/attempt-stream.ts                                                                 | 重写（估算源 outputText→outputFeatures，C1）              | src/application/stream.ts                           |
| apps/gateway/src/pipeline/settle-retry.ts                                                                   | 复制+微修（去 OTel；上限 8s 参数化）                      | src/application/signal-retry.ts                     |
| apps/gateway/src/pipeline/upstream-port.ts / upstream-adapter.ts                                            | 重写（v2 ai 平参数 API；ChannelDesc 组装+凭据解密注入）   | src/ports/upstream.ts + src/adapters/upstream-ai.ts |
| packages/core/src/redis/ai-storages.ts                                                                      | 复制+微修（Lua CAS；前缀 inference:health:）              | src/adapters/state-redis.ts                         |
| apps/gateway/src/pipeline/ai-storages.ts（memory）                                                          | 复制+微修                                                 | src/adapters/state-memory.ts                        |
| packages/domain/src/generation/kinds.ts                                                                     | 复制（video=task_poll / music=task_execute + 参数白名单） | src/domain/generation.ts                            |
| apps/gateway/src/generation/submit.ts                                                                       | 重写（限流剥离；TaskStore port 化）                       | src/application/generation.ts                       |
| （v1 poll 在 service/worker）                                                                               | 不迁（结算/worker 垂直，后续波次；MIGRATION 待办）        | —                                                   |
| packages/domain/src/rating/{pricing,calculate,pricing-strategy,reservation-strategy,coefficient,amounts}.ts | 不迁（金额运算归 billing 包）                             | —                                                   |

## 3. 拆分后的包结构

```text
src/
├── domain/
│   ├── errors.ts                # InferenceErrors 目录
│   ├── model/
│   │   ├── types.ts             # 目录快照/渠道候选/报价候选契约类型
│   │   ├── candidates.ts        # 主模型+fallback 一级展开、去重
│   │   └── output-cap.ts        # 输出上界 + 钳制 + 输入保守上界
│   ├── routing/
│   │   ├── schedule.ts          # priority 层 + weight 无放回加权随机
│   │   └── switchable.ts        # ErrorKind → switch/respond/next 判定
│   ├── usage/
│   │   ├── attribution.ts       # 估算归属词表 + streamEstimateAttribution
│   │   ├── estimate.ts          # 特征四计数器 → token 估算（C1）
│   │   ├── measurement.ts       # pricingUnit → units 计量注册表
│   │   └── receipt.ts           # buildReceipt（价格快照 + 可信/估算 usage）
│   └── generation.ts            # 任务种类注册表 + snapshotParams 白名单
├── health/
│   ├── breaker.ts               # closed/open/half-open（CAS 状态机）
│   ├── dead-credential.ts       # 连续计数（CAS 状态机）
│   └── channel-health.ts        # AiEvent 订阅者 + admit 检查 + 事件→状态映射
├── ports/
│   ├── upstream.ts              # UpstreamPort + 端口结果形态
│   ├── catalog.ts               # CatalogPort（control-plane 只读）
│   ├── billing.ts               # BillingPort（quote 基础事实/authorize/reserve/signal）
│   ├── state.ts                 # HealthStore（版本化 CAS 存储）
│   └── generation.ts            # GenerationTaskStore + 任务视图
├── adapters/
│   ├── upstream-ai.ts           # 封装 ai：ChannelDesc 组装 + 凭据解密 + 事件映射
│   ├── state-redis.ts           # Lua CAS（ioredis）
│   ├── state-memory.ts          # 单副本/测试 CAS
│   └── task-memory.ts           # 单副本/测试任务存储
├── application/
│   ├── quote.ts                 # 预检：白名单/估算/上界钳制/候选链
│   ├── failover.ts              # 候选×渠道循环 + 三分派 + 全败终结
│   ├── signal-retry.ts          # 终态 signal 退避重试
│   ├── chat.ts                  # 非流式尝试（先结算后交付）
│   ├── stream.ts                # 流式尝试（决定性事件 + 续租 + 后台结算）
│   └── generation.ts            # 提交/查询用例
├── config.ts                    # zod 缺省（DESIGN §4 词表）
├── inference.ts                 # createInference facade
└── index.ts                     # 公共出口（barrel）
```

与结构文档差异：测试目录用铁律 14 的平铺 `__test__/`（结构图 `test/{…}` 子目录已被铁律覆盖）；
ports 增加 `generation`（垂直用例的持久化接缝，结构图清单非穷举）；不建 `adapters/http` 空壳
（http 语义已在 ai 传输层，本包无独立 http I/O——铁律 4 禁占位）。

## 4. 测试计划（铁律 14：平铺；铁律 16：边界即规格）

| 文件                         | 覆盖                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| schedule.test.ts             | priority 严格分层、weight 无放回、weight≤0→1、全 0 等概率、rng 确定性                          |
| switchable.test.ts           | 19 kind 全矩阵表驱动 + 内部拒绝码 + 4xx 透传边界                                               |
| candidates.test.ts           | fallback 一级展开、mappingId 去重、缺映射跳过、主缺失即 model_not_found                        |
| output-cap.test.ts           | max_completion_tokens>max_tokens>缺省、×n、封顶、注入、钳制引用语义、字节上界                  |
| attribution.test.ts          | terminated 矩阵（undefined/用户侧三态/inactivity/server_draining/未知→partial）+ 词表封闭性    |
| estimate.test.ts             | 空文本、纯 CJK、混合文本、系数覆写、非有限值防御                                               |
| measurement.test.ts          | token/image/second/char/request 计量矩阵 + 参数兜底                                            |
| receipt.test.ts              | 可信 usage/估算 usage 双分支、units、cacheWrite 透传、credentialType                           |
| generation.test.ts（domain） | 种类注册表封闭性、snapshotParams 白名单、未知 kind 拒绝                                        |
| breaker.test.ts              | 窗口计数、阈值跳闸、429 不跳、half-open 单探测、CAS 竞争、TTL                                  |
| dead-credential.test.ts      | 连续计数、窗口重置、阈值 invalid、成功自愈                                                     |
| channel-health.test.ts       | 事件→状态映射矩阵（failed/success/terminated 族/empty 不计）、admit 拒绝、退订、回调异常不外溢 |
| state-redis.test.ts          | 真实 Redis CAS 原子性（REDIS_URL 未配置整套 skip）                                             |
| upstream-ai.test.ts          | ChannelDesc 组装（override/解密/vendor）、结果/事件映射、任务三操作                            |
| quote.test.ts                | 白名单拒绝、估算与上界、候选空 → model_not_found                                               |
| failover.test.ts             | 换渠/换候选/透传三向、admit 拒绝换渠、预算拒绝换渠、全败 503/502 语义、upstream_started 一次   |
| chat.test.ts                 | 成功先结算后交付、估算收据、结算耗尽 finalize_unavailable、4xx 透传收尾                        |
| stream.test.ts               | 决定性事件锚定、failed 前置换渠、续租节奏/上限/终态即停、终态收据归属、取消流                  |
| generation-app.test.ts       | task_poll 提交、task_execute 登记、持久化失败 billing_receipt_unavailable、查询属主            |
| api.test.ts                  | facade 出口快照、defaults 缺省与覆写、close 退订                                               |

覆盖率阈值 90/90/90/85（vitest thresholds）；`src/index.ts` 桶不计分母。

## 5. 实施顺序（每步可独立验证）

1. 脚手架 + config + domain（纯函数先行，全部可单测）；
2. ports + health 状态机（memory store 驱动）；
3. adapters（upstream-ai 事件映射 + redis CAS）；
4. application（quote → failover → chat/stream/generation）+ facade；
5. 测试补齐至覆盖率阈值 → 四门（typecheck/lint/test/build）→ 文档核销。

## 6. 实施记录（2026-08-23 核销）

- 四门：typecheck / lint(oxlint 0 error) / test / build 全绿；oxfmt 全仓格式一致。
- 测试：21 文件、120 用例（默认门禁 119 过 + 1 skip——真实 Redis 段按 REDIS_URL 门控；
  本机 Redis 实跑 3/3 过，含并发 CAS 单赢家原子性）。
- 覆盖率：statements 97.52 / branches 90.77 / functions 96.63 / lines 97.65
  （阈值 90/85/90/90，未调阈值）。
- 实施期缺陷 B11（边界用例抓出，铁律 16 实证）：channel-health 初版将熔断与死凭据两台
  状态机指向**同一存储键**，两种状态形状互相踩踏（v1 以双前缀规避的坑在重写中复现）；
  修复 = 机器级键前缀 `breaker:` / `credential:`（结构约束，不依赖装配侧给不同 prefix），
  已补按编号命名的回归用例（channel-health.test.ts「B11 回归」）。
- 与老仓的对照核销清单见 MIGRATION.md §4（17 项全勾）。
- bun.lock 混有并行会话（accounts/billing/control-plane）条目，未随本次提交（铁律 15），
  待协调收口。
