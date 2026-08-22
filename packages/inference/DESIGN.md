# @tokenlens/inference 设计基线

> 状态：定稿（2026-08-23）
> 定位：推理用例、路由候选循环、计费衔接与故障转移（重构方案 §3.1 / §5.2）。
> 依赖方向：`inference → ai`（库依赖）＋ `errors`；billing / control-plane 经消费方 port 注入，未建包前不产生编译依赖。
> 施工图与审计裁决见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)；行为规格对照见 [MIGRATION.md](./MIGRATION.md)。

---

## 1. 外部契约

### 1.1 facade

```ts
createInference(env: InferenceEnv): Inference

interface InferenceEnv {
  ai: Ai;                        // 装配传入的 @tokenlens/ai 实例（inference 是其唯一运行时消费方，§3.6）
  catalog: CatalogPort;          // control-plane 只读目录（未建包，装配注入实现）
  billing: BillingPort;          // billing 能力（未建包，装配注入实现）
  store: HealthStore;            // 渠道健康跨请求状态存储（redis 装配 / memory 单副本开发）
  decrypt: (enc: string) => string;  // 渠道凭据解密（runtime Cipher 装配注入，必填）
  upstream?: UpstreamPort;       // 缺省用内置 ai 适配器；测试/特殊装配可注入替身
  tasks?: GenerationTaskStore;   // 缺省用内置内存实现（单副本开发/测试）；生产装配 postgres 实现
  admitChannel?: ChannelAdmission;  // 渠道维限流钩子（gateway app 装配；未装配 = 放行，单副本形态）
  defaults?: InferenceDefaultsInput;  // zod 缺省可覆写（§4 词表）
  onError?: (error: unknown, context: string) => void;  // 运维旁路日志（结算重试/健康写入失败）
}

interface Inference {
  chat(input: ChatInput): Promise<ChatOutcome>;
  stream(input: ChatInput): Promise<StreamOutcome>;
  generation: {
    submit(input: GenerationSubmitInput): Promise<GenerationSubmitOutcome>;
    query(userId: number, taskId: string): Promise<GenerationTaskView>;
  };
  readonly health: ChannelHealth;   // 装配诊断面（admit 检查/退订）
  close(): void;                    // 退订 ai 事件总线
}
```

- 参数平铺不嵌套（auth/model/body 同级）；结果一律判别联合。
- `requestId` 缺省 `randomUUID`；`body.model` 为对外目录模型名，真实名替换在 ai 适配器（`CallOptions.model`）完成。

### 1.2 结果形态

```ts
type ChatOutcome =
  | { ok: true; status: 200; body?: unknown; rawBody?: Uint8Array; rawContentType?: string }
  | { ok: true; passthrough: true; status: number; code: string; message?: string } // 上游 4xx 原码透传
  | { ok: false; error: BusinessError }; // inference 目录错误（§3）

type StreamOutcome =
  | { ok: true; status: 200; stream: ReadableStream<Uint8Array>; contentType: 'text/event-stream' }
  | { ok: false; error: BusinessError };
```

- 透传例外与错误出站三层归 app face / ai（§3.6）：inference 不改写上游体，4xx 透传只携带
  归一事实（kind/status/原文 message），脱敏由消费面渲染时执行；上游细节同时经 `onError` 进日志。
- `ChatOutcome` 不含收据：收据是 billing 衔接的内部事实，经 `BillingPort.signal` 出包，不回传调用方。

## 2. 问题域：处理什么 / 不处理什么

**处理**（本包职责）：

- 模型白名单判定（凭证 `allowedModels`）；
- 候选链装配（主模型 + fallbackModels 一级展开、去重）与渠道加权调度（priority 层 + weight 无放回加权随机）；
- 候选 × 渠道双层循环、换渠/换候选/透传三分派、全败终结（no_available_channel / upstream_failed）；
- 输出上界钳制（max_completion_tokens > max_tokens > 缺省，×n，封顶）与输入保守上界（JSON UTF-8 字节数）；
- 渠道健康跨请求状态：熔断（closed/open/half-open）与死凭据（连续计数），AiEvent 订阅者身份维护；
- 收据装配（命中候选价格快照 + 可信/估算 usage + 计量 units + 估算归属）与终态 signal 退避重试；
- 流式上线后租约续期（1/3 TTL，上限 100 次）与终态后台结算；
- 生成任务提交（video=task_poll 上游提交 / music=task_execute 仅登记）与属主查询。

**不处理**（写清归属）：

- 凭证维/用户维 RPM/TPM 准入与 TPM 预占归还 → gateway app 中间件（装配 `admitChannel` 钩子覆盖渠道维）；
- 钱包预扣/结算/恢复/对账（金额运算、汇率、限额）→ `billing` 包（经 `BillingPort`）；
- 模型/渠道/费率配置管理与目录持久化 → `control-plane` 包（经 `CatalogPort`，只读）；
- 渠道死凭据永久拉黑（`channels.status=4`）与运营告警 → control-plane 经通知消费（未来波次；本包只维护
  redis 状态机，成功自愈）；
- 协议细节/传输/SSRF/透传中继 → `ai` 库；
- usage 估算的 BPE 精确层 → `ai` 内部（v2 不再导出；inference 用特征四计数器 + 校准系数，§5 C1）。

## 3. 错误目录（§11 根契约）

`defineErrorCatalog('inference', …)`，message 一律英文、zh 必填：

| key                           | category    | 语义                                            |
| ----------------------------- | ----------- | ----------------------------------------------- |
| `model_not_found`             | not_found   | 目录无此模型（或候选为空）                      |
| `model_not_allowed`           | forbidden   | 凭证白名单拒绝                                  |
| `no_available_channel`        | unavailable | 渠道面竭尽（无渠道/预算耗尽/限流），对应 v1 503 |
| `upstream_failed`             | unavailable | 上游故障全败（非渠道面），对应 v1 502           |
| `finalize_unavailable`        | unavailable | 非流式结算重试耗尽（未交付不结算）              |
| `billing_receipt_unavailable` | unavailable | 生成任务已受理但收据持久化失败（预留保留）      |
| `task_not_found`              | not_found   | 生成任务不存在/非属主                           |

业务拒绝 `InferenceErrors.business(key, context)` 直抛；上游原文/内部细节只进日志与 `context`（数字/枚举事实）。

## 4. 配置词表（zod 缺省，装配可覆写；单一真相在本包 config）

| 组             | 键                                                                   | 缺省                        | 出处                            |
| -------------- | -------------------------------------------------------------------- | --------------------------- | ------------------------------- |
| breaker        | windowMs / failureThreshold / cooldownMs / halfOpenProbe             | 60_000 / 5 / 300_000 / true | v1 ai 配置                      |
| deadCredential | failureThreshold / windowMs                                          | 3 / 3_600_000               | v1 ai 配置                      |
| output         | defaultMaxOutputTokens / exposureCap                                 | 4_096 / 32_768              | v1 gateway 配置                 |
| authorization  | ttlMs                                                                | 300_000                     | v1 BILLING_AUTHORIZATION_TTL_MS |
| streamLease    | minRenewIntervalMs / maxRenewals                                     | 1_000 / 100                 | v1 attempt-stream               |
| settleSignal   | attempts / baseDelayMs / maxDelayMs                                  | 5 / 500 / 8_000             | v1 settle-retry                 |
| generation     | taskTtlMs / leaseGraceMs                                             | 3_600_000 / 30_000          | v1 gateway 配置                 |
| estimate       | cjkTokensPerChar / tokensPerWord / tokensPerNumber / tokensPerSymbol | 0.7 / 1.1 / 1.0 / 1.0       | v1 校准缺省（C1）               |
| upstream       | deadlineMs                                                           | 120_000                     | v1 GATEWAY_UPSTREAM_DEADLINE_MS |

## 5. 契约演进（相对 v1，随 MIGRATION.md §4 核销）

- **C1 估算口径**：ai 不再公开 BPE 估算器；缺 usage 的实扣估算 = `extractTextFeatures`（ai 公开）+
  本包校准系数（装配可调）。字节保守上界仍只作敞口，不入实扣（v1 政策保留）。
- **C2 汇率快照**：收据不再携带网关侧 fx 快照；汇率事实由 billing 在结算时点固化（billing 波次裁决归属）。
- **C3 死凭据单一阈值**：v1「redis 3 连 + DB 即刻拉黑」双真相合并为 health 状态机单阈值（3 次/1h/成功自愈）；
  永久拉黑经 control-plane 通知路径（待办）。
- **C4 健康状态消费点**：v1 在 ai 内部 admission 拒绝（`circuit_open`/`dead_credential` 错误码）；v2 由
  inference 候选循环在尝试前 `health.admit` 检查，拒绝视同换渠（行为等价：换下一渠道）。
- **C5 结算信号词表**：`request.succeeded/failed` → `request_succeeded/request_failed`（蛇形对齐根契约风格）。

## 6. 并发与性能预算

- 健康订阅回调微秒级：事件只做 O(1) 判型与 fire-and-forget 异步状态机更新（`void …catch`），CAS 竞争由
  存储层原子性保证，更新失败降级「放弃本次计数」（v1 同款语义，保护性机制尽力而为）。
- 路由 `admit` 为每渠道一次存储读（每请求 O(候选×渠道) 常数次，可接受）。
- 流式租约：每流单 `setInterval`（unref），终态即停，续期上限 100；结算重试期间续租不停（v1 纪律）。
- 数据面透传零接触：inference 不进入流路径，只消费事件面。

## 7. 边界

- 包依赖：`@tokenlens/ai`、`@tokenlens/errors`、`zod`、`ioredis`（redis 适配器类型与 CAS）；
  `@tokenlens/runtime`（仅测试装置子入口，devDependency）。
- 根出口只导出 facade、输入/结果类型、目录、端口类型与两个适配器工厂（upstream-ai / state-redis /
  state-memory / task-memory 供装配选择）；不导出 ai 类型再分发（消费方自 `@tokenlens/ai` 引用）。
