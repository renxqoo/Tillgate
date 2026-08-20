# 计划:packages/ai v2 重构(机制链拆解 + 组合契约 + 厂商档案)

> 状态:**P0–P5 全部完成 + 第二批 pi-ai 资产吸收收口(2026-08-20,分支 refactor/ai-package-v2)**。
> 第二批:模型元数据同步(models.dev)/BPE 真分词器/档案扩充 7 家/静默溢出兜底/
> cache_write 数据捕获,详见 CHANGELOG §16。覆盖率门禁
> 90/85 上线(实测 94.8/85.1/93.2/96.8);gateway e2e 32/32;施工中发现并修复
> 4 处生产缺陷(endpoint 寻址/multipart 拆包/abort 丢失/契约窄化),详见 CHANGELOG §15。
> 实施偏差:vendor profile 首批仅含已验证条目(openai),原定 8 家因无实证来源修订
> (自造规则破坏真实请求的风险大于收益);P4 顺带删除了 ai 包死模块 descriptors。
> 原则:行为逐位保真(透传/心跳/[DONE]/计费语义不变)/ 删除优于兼容(铁律 8,不留双轨)/
> 每阶段独立可合入可回滚(四门全绿才算完成)。

## 1. 背景与现状诊断

`packages/ai` 方向正确(纯机制库零业务依赖、规范形单一真相、openai-compatible 字节透传、
存储依赖倒置),但存在四类问题(证据见 ai-package.md §6 与源码):

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 1 | `create-ai.ts` 768 行编排上帝文件 | 违反 AGENT.md §0.5(一动词一文件 ~150 行);重试/熔断/死凭据准入/端点分发/事件发射/流式生命周期全焊死在一个闭包 | 加任何横切机制都要动大文件 |
| 2 | 契约胖接口 + 继承式扩展 | `adapters/protocol-adapter.ts` 6 必选 + 4 可选方法;AzureOpenAIAdapter 靠继承覆写寻址 | 新协议边际成本高(原生线格式 ≈ 400–500 行 codec + 全量适配器);无法只覆写一件事 |
| 3 | 接缝断连(生产 bug) | `RequestCtx` 有 endpoint 但 gateway `upstream-adapter.ts` 不传,`create-ai.ts` 兜底 `?? 'chat'` | embeddings/images/audio/rerank/moderations 的上游路径分支(`openai-compatible.ts:55-72`)生产不触发;兜底违反零写死铁律 |
| 4 | 计量/分类缺口 | usage 方言仅 OpenAI+DeepSeek(normalize.ts 69 行);上下文溢出错误无分类(当普通 4xx 透传);Usage 无 cache_write 维度 | Anthropic 1h 缓存/Mistral/Google 方言漏归一;溢出错误会走无意义换渠重试;cache_creation 计量现状待核查(§7 决策门) |
| 5 | 任务族词表污染 | `ProtocolTaskOps.parseResponse(endpoint: 'video' \| 'music')` 把 MiniMax 业务词表硬编码进通用契约 | 厂商知识泄漏到协议层 |

前置调研关键结论(为什么不是换包):pi-ai(@earendil-works/pi-ai)是 agent 客户端 SDK
(统一 Context 模型、SSE 全量解析、请求体重构造丢字段、无字节透传出口),与透明中继网关
正交;其可吸收资产为:models.dev 模型元数据上游(981 模型 × 35 供应商)、overflow 错误
模式库(20+ 供应商正则 + 排除表 + 静默溢出策略)、usage 方言实现、OpenAICompletionsCompat
厂商怪癖词汇表(17 开关,含 thinkingFormat 十种 reasoning 参数方言)。

## 2. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| 1 | 传输引擎 | **自研保留,不引入 pi-ai/官方 SDK 运行时依赖**。透传保真/计费语义/测试资产(38 文件)零损耗 |
| 2 | 资产吸收 | 数据与知识直接搬(overflow 库/usage 方言/models.dev 对接);模式照抄(vendor profile/最小契约/registry);`models.dev` 为模型数据**唯一上游**(pi-ai 的生成文件只是二道贩子,不复制) |
| 3 | Vendor Profile 执行 | profile **编译进现有 ignore→map→clamp 规则引擎**(单一执行路径),不建第二套规则引擎 |
| 4 | Profile 归属 | 内置库**进代码不进库表**(quirk 是机制事实,随包发版带测试);渠道只存 vendor 字符串引用,admin 端下拉引用注册表 |
| 5 | 契约分粒度 | 拆 5 能力件 + `defineAdapter` 组合器;`ProtocolAdapter` 保留为**类型别名**(聚合类型,非兼容层),现有 7 适配器零改动可注册 |
| 6 | protocol/ 目录 | **不改名不迁移**(codec 五模块是网关对外契约的一部分,导出面全量保留) |
| 7 | RequestCtx.endpoint | 改**必填**(类型层强制),删 `'chat'` 兜底;gateway 从 inferenceKind 映射补传,全消费方同批改(铁律 8) |
| 8 | cache_write | **决策门隔离**:先核查真实 Claude 渠道流水 usage.raw;若漏计/错计 → 独立资金工单(动 db 费率卡 + rating + wallet),不混入本重构 |
| 9 | create-ai 拆解纪律 | 纯搬移 + 提取函数,**不顺手改逻辑**;行为修正全部走 P1 独立提交 |
| 10 | 测试基线 | **不作废任何现有测试**;characterization(含既有 upstream-wire.characterization)作行为对比器;e2e 三件套(v1-parity/upstream-smoke/e2e-cost-drain)为重构验收器 |

## 3. 目标架构

```
packages/ai/src/
  index.ts                     # 公共导出面——对外符号不变(gateway/worker/admin-api/admin 四处消费零破坏)
  types.ts / config.ts / events.ts   # 契约微调(RequestCtx.endpoint 必填;其余不变)
  registry/                    # 新增:注册表与组合器
    define-adapter.ts          # 5 能力件组合器 + 适配器注册表(替代 create-ai.ts:98-104 硬编码数组)
    vendor-profiles.ts         # 内置厂商兼容档案库(首批 8 家,§5)
  pipeline/                    # 新增:create-ai.ts 拆解为机制链
    admission.ts               # 熔断 + 死凭据准入判定
    plan-request.ts            # adapter 寻址 + joinUrl + 请求体终改 + 签名(时序正确位置不变)
    chat.ts                    # 非流式 dispatch:readBody → translate → extractUsage/estimate → 错误分类
    chat-stream.ts             # 流式 dispatch:translate → peek → relay → scanner → 事件发射
    probe.ts                   # 连通性探针
  join-url.ts                  # baseUrl 版本段去重(纯函数,从 create-ai 提出)
  adapters/                    # 7 协议:openai-compatible 瘦身(quirk 迁 profile);azure 改 defineAdapter 组合式
  protocol/                    # codec 五模块不动(claude-chat/gemini-chat/responses-chat/completions-chat/stream-convert)
  transport/                   # http-client / relay-stream / sse-parser 不动(SSRF 硬门零改动)
  usage/                       # normalize + 三方言;calibration/token-estimate/media-duration 不动
  errors/                      # classify 增强;新增 overflow.ts(溢出模式库,pi-ai 移植)
  breaker/ dead-credential/ retry/   # 机制不动
  generation/                  # 任务族词表泛化(§6)
  internal/                    # 不动
```

不变量守护神全部保留:`UpstreamError` 三标志(retryable/circuitTrip/deadCredential)、
`AiEvent` 词表、terminated 七归因、`estimated:true` 不可信上抛、「管线内部恒规范形」、
`SUPPORTED_PROTOCOLS` 从注册表导出(admin 前端消费不变)。

## 4. 契约分粒度(治胖接口)

```ts
// registry/define-adapter.ts
interface Addressing    { planRequest(...); probeRequests(...); signRequest?(...) }
interface BodyFinalizer { finalizeRequestBody(...) }
interface UsageExtractor{ extractUsage(...) }
interface ErrorMapper   { mapError(...) }
interface WireCodec     { translateResponseBody?(...); translateUpstreamStream?(...) }

defineAdapter({ addressing?, body?, usage?, errors?, codec?, tasks? }): ProtocolAdapter
// 缺省件自动落 OpenAI 兼容默认实现
```

- **Azure 改造为样板**:`defineAdapter({ addressing: azureAddressing })` 消灭继承;
- `ProtocolAdapter = Addressing & BodyFinalizer & UsageExtractor & ErrorMapper & Partial<WireCodec>`(类型别名,非兼容层);
- 新增原生协议的成本结构变为:寻址/错误/usage 各自挑件实现 + WireCodec(仅原生线格式需要)。

## 5. Vendor Profile 体系(治扩展贵,核心增量)

```ts
// registry/vendor-profiles.ts
interface VendorProfile {
  params: ParamRulesTemplate;        // maxTokensField / thinkingFormat 方言 / dropParams / requiresToolResultName…
  usageDialect?: 'openai' | 'deepseek' | 'minimax' | 'mistral' | 'google';
  overflowHints?: RegExp[];          // 该厂商溢出错误模式(进 errors/overflow.ts 判定)
  addressing?: PathRewrite;          // 少数厂商路径前缀差异
}
```

三红线:①编译进单一规则引擎(决策 #3);②机制知识进代码不进库表(决策 #4);
③profile 与 adapter 正交——profile 只服务 openai-compatible 族,原生协议走 §4 组合件。

内置库首批 8 家:deepseek / minimax / moonshot / qwen / groq / together / openrouter / zai,
内容从 pi-ai OpenAICompletionsCompat + overflow 库反向提炼(thinkingFormat 十种方言 →
ParamRules 映射表)。**验收演示:接一家新 OpenAI 兼容厂商 = 建渠道选 vendor,零代码零规则配置。**

## 6. 任务族泛化(治词表污染)

- `ProtocolTaskOps.parseResponse(kind: GenerationTaskKind, ...)`:`generation/descriptors.ts`
  的 `GENERATION_KINDS` 成为任务词表唯一来源('video'|'music' 字面量从通用契约删除);
- MiniMax 的 base_resp 归一/status 映射继续收在 adapter + task-kit 配置内(现状已对);
- worker `generation-adapter.ts` 同批适配。

## 7. P1 正确性修复(先行,与重构解耦)

1. **ctx.endpoint 接缝**(决策 #7):types.ts 必填化 → 删 create-ai 兜底 → gateway
   `upstream-adapter.ts` 从 body 的 inferenceKind 映射 endpoint → worker/admin-api 消费点同批改。
2. **usage 方言**:normalize.ts 补 Anthropic `cache_creation.ephemeral_1h_input_tokens`、
   Mistral 四字段名兜底、Google `thoughtsTokenCount` 计入 output。
3. **溢出错误库**:新增 errors/overflow.ts(模式 + Throttling 排除表 + 静默溢出兜底),
   classify 产出新码 `context_overflow`——不可重试/不可熔断计 trip/不换渠/4xx 透传给用户;
   gateway `routing/switchable.ts` 词表同批加该码。
4. **cache_write 决策门**(决策 #8):查真实 Claude 渠道 usage_logs 的 usage.raw 原文,
   确认 cache_creation token 现状 → 正确则记 CHANGELOG 关闭疑点;漏计/错计则开独立资金工单。

## 8. 分阶段实施(单人约 4 周)

### P0 准备(0.5d)
改动:对 peek/relay/事件序列补 characterization 测试(逐字节断言流为基准);本文档 §3–§6
作为目标稿反写进 ai-package.md 的修订清单(暂不发布)。
验收:新增特征化测试绿。回滚:git revert(纯测试)。

### P1 正确性(2–3d)
改动:§7 四项(#4 只出核查结论与决策)。
验收:四门全绿;`context_overflow` 从 mock 上游到 gateway 透传端到端可用;回归钉死新用例。
回滚:git revert(纯代码,无 DB)。

### P2 机制链拆解(3–4d)
改动:create-ai.ts → 装配壳(<120 行,Ai 七方法薄委托)+ pipeline 五模块 + join-url.ts;
纪律:纯搬移 + 提取(决策 #9)。
验收:四门全绿;characterization 与 e2e 三件套零行为 diff;全包文件 ≤ ~150 行(协议 codec 除外,注明豁免理由)。
回滚:git revert。

### P3 契约 + Profile(6–8d)
改动:§4 defineAdapter + 注册表;§5 vendor-profiles 内置 8 家 + ParamRules 编译器;
Azure 改组合式;MiniMax chat 侧 quirk 迁 profile;admin-api providers 校验接注册表、
admin providers 页加 vendor 下拉(channels 表加 vendor 列——唯一 DB 变更,加列可空无迁移风险)。
验收:「零代码接入新厂商」演示用例绿;profile 编译测试(每家 profile → 生成 ParamRules 快照断言)。
回滚:代码 revert;channels.vendor 列留存无害。

### P4 任务族泛化(2–3d)
改动:§6。
验收:worker 任务轮询测试绿;词表 grep 无 'video'|'music' 字面量残留于通用契约。
回滚:git revert。

### P5 收尾(1d)
改动:ai-package.md §6/§7 全量重写(与代码一致);CHANGELOG 施工资留痕;AGENT.md 仓库地图微调。
验收:文档与代码一致(目录树逐项核对)。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 拆解行为漂移 | 纯搬移纪律 + characterization 逐字节对比 + e2e 三件套作验收器(P0 先建兜底) |
| profile 与 param_rules 双轨 | 编译进单一引擎(红线 ①),profile 只在生产侧作为「规则模板来源」存在 |
| endpoint 必填引爆暗调用方 | 类型系统兜底;全仓消费点已知 4 处一批改完 |
| 测试资产损耗 | 本计划不作废任何现有测试(与换包方案的本质区别);新增约 15–20 文件 |
| cache_write 跨域扩散 | 决策门隔离(#8),独立资金工单 |
| 思维漂移(重构顺手加功能) | 新协议/多密钥/定时探活/models.dev 同步一律另立工单(§10) |

## 10. 重构完成后自然解锁(另立工单,不属本次)

models.dev 目录同步脚本(admin-api 域,价格走审批快照入库)、定时探活、多密钥渠道、
第 8 种协议(新架构下:原生协议 ≈ codec + 组合件;兼容厂商 ≈ profile 一条配置)。

## 11. 来源与许可说明

- overflow 模式库 / usage 方言 / compat 词汇表:源自 @earendil-works/pi-ai(MIT,本地
  /Users/wrr/work/pi/packages/ai),移植需保留 attribution 注释;测试用例可参照其 80 个测试反向构造。
- 模型元数据上游为 models.dev,对接前确认其数据许可条款;价格属资金语义,**同步必须走审批快照,禁止自动生效**。
