# @tillgate/ai

> 上游协议库:透传中继 + 多协议适配 + 多模态 + 事件观察面(§3.6 数据面/观察面契约,零运维状态)。
> 裁决:[ADR-0006](../../docs/adr/0006-ai-standalone-library.md)(保留为独立库、依赖图永久叶子);
> 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md);装配注入形态 [ADR-0007](../../docs/adr/0007-apps-assembly-ai-injection.md)。

一句话:单渠道内的机制链(参数抹平 → 单次尝试 → 重试 → 逐块透传);候选循环、路由、
计费衔接全部在 `inference`。零 `@tillgate/*` 依赖,自有 `ErrorKind` 封闭词表。

## 核心导出面

- `createAi(defaults?, deps?, options?)` → `Ai`:`chat` / `chatStream`(透传管道,重试仅限
  首字节前) / `use`(渠道绑定糖) / `probe`(连通性探测) / `subscribe`(观察面) / `tasks`
  (video/music 异步生成任务 parse/query/file)。
- `SUPPORTED_PROTOCOLS` 协议词表单一真相:openai-compatible / anthropic / gemini /
  azure-openai / aws-bedrock / vertex-ai / minimax / dashscope 八个内置适配器
  (`options.adapters` 可替换注册表)。
- **onEvent 观察面契约**:`subscribe(observer)` 全局事件总线(装配处只挂一次,返回退订函数);
  `AiEvent` 判别联合(`attempt_start` / `first_chunk`(TTFB 权威锚点) / `param_adjustment` /
  `stream_error` / `aborted` / `failed` / `empty_completion` / `success`)。回调
  fire-and-forget:观察者异常被吞、不得阻塞、不得做 IO;`usage` 是 success 终态的随行
  累计值(最新者胜出),中断且无 usage → 账务 uncertain,禁止估成 0 扣费。
- 错误归一单一真相:`UpstreamError` / `isRetryable` / `isDeadCredential` / `KIND_MECHANICS`
  (kind → 机制单点派生表)。
- 入站协议翻译:completions / responses / claude / gemini 外部线格式 ↔ 规范 chat 形的
  纯函数(app 经 `@tillgate/inference` 转出口消费——apps 运行时不直接 import 本包)。
- 配套件:`vendorProfileNames` 厂商档案词表、`assertSafeUrl`(URL 守卫)、
  `extractTextFeatures` / `TextFeaturesAccumulator`(估算充分统计量,O(1) 内存)。

## 目录结构

```
src/
├── create-ai.ts     # createAi 装配壳:适配器注册表 + 事件总线 + 重试包裹
├── types.ts         # Ai / CallOptions / Usage 等外部契约类型
├── events.ts        # AiEvent 观察面契约(顺序约定 + 计费语义)
├── config.ts        # AiDefaults zod schema(重试/超时可覆写缺省)
├── adapters/        # 协议适配器 ×8 + protocol-adapter 扩展契约
├── pipeline/        # 单次尝试体:attempt-chat / attempt-stream / tasks / stream-report
├── protocol/        # 入站协议翻译(completions/responses/claude/gemini ↔ 规范形)
├── transport/       # http-client(fetch/守卫) + relay-stream(逐块透传)
├── registry/        # vendor 档案与参数规则
├── retry/           # withRetry(可重试错误 + 空完成独立预算)
├── usage/           # 文本特征计数器 + 音频时长估算
├── errors/          # UpstreamError kinds + 出站脱敏
├── internal/        # 包内私有工具(json 等)
└── index.ts         # 唯一公共出口
```

## 装配

消费方:`apps/gateway`、`apps/worker`(assembly `createAi` 实例注入 `inference`,
按 ADR-0007)、`apps/admin-api`(仅词面:`SUPPORTED_PROTOCOLS` / `vendorProfileNames` /
`assertSafeUrl`,供 control-plane 校验与安全检查)。运行时唯一消费方是
`@tillgate/inference`。

## 开发

```bash
cd packages/ai
bun run typecheck && bun run lint && bun run test
bun run test:real   # providers.real.test.ts:真上游(MiniMax/DeepSeek)集成,花真钱;
                    # 需 MINIMAX_API_KEY / DEEPSEEK_API_KEY(根 .env),无 key 自动 skip
```
