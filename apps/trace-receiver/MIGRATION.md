# trace-receiver app 迁移文档(MIGRATION.md)

> 状态:已核销(行为对照逐项落位于 `__test__/receiver.test.ts` + `receiver.real.test.ts`)
> 迁移单元:OTLP 接收部署单元的 HTTP 面/入口/装配(batcher/decode/store 已在 observability 波次先行)
> 旧实现:/Users/wrr/work/ai-getway/apps/trace-receiver(src 4 文件 292 行;receiver.test.ts 218 行)
> 目标位置:apps/trace-receiver
> 关联:本包 IMPLEMENTATION.md(R# 演进编号)/ packages/observability/IMPLEMENTATION.md(B#/G#)

## 1. 行为规格基线

旧测试清单(receiver.test.ts,6 用例):

- SpanBatcher 段 2(队列满丢最旧计数/写失败丢弃计数)→ observability `__test__/tracing-ingest.test.ts`
  (该波已改写迁入,本波不重复)。
- HTTP 面段 4(真 PG:bodyLimit 413/token 门 401/415+400 族/端到端点查)→ 本包
  `__test__/receiver.real.test.ts` 行为等价移植(信封码按 R1/R2 演进)。
- **新增**(v1 无规格,本波补):config 层 19 用例(缺省表/模式推导/fail-fast 闸/令牌三道门)、
  HTTP 面单测 9 用例(零 PG,信封码与计数算术)、assembly 2 用例(装配 fail-fast/off 全链)。

## 2. 审计结论(引用,不重复抄写)

- 影响本单元的真 bug:**R6**(v1 NODE_ENV 被 zod strip,生产令牌检查恒不触发)——已修,
  config.test「生产缺令牌 fail-fast」锁定;其余 v1 缺陷(B6 batcher O(n) 等)归 observability 波次。
- 挂账兑现:observability IMPLEMENTATION §7 挂账#3(token-compare 合一)→ `@tokenlens/http`
  `timingSafeTokenEqual`(挂账条目已在该文档核销);G6(接收端按码映射 400)→ onError 合成目录渲染。

## 3. 逐模块裁决表

| 旧文件                     | 行数 | 裁决       | 审计状态 | 动作                                                                   |
| -------------------------- | ---- | ---------- | -------- | ---------------------------------------------------------------------- |
| batcher.ts                 | 103  | 已迁(前波) | B6 记录  | observability `tracing/ingest`;app 改消费 `createSpanBatcher`(R9)      |
| app.ts                     | 116  | 重构       | 无缺陷   | 平移+错误面入目录体系(R1/R2/R3/R8);bodyLimit 用 http `bodyParserLimit` |
| index.ts                   | 58   | 重构       | 无缺陷   | 拆 config/assembly(目标树);停机样板 → runtime `createShutdown`(R7)     |
| token-compare.ts           | 17   | 上收       | 无缺陷   | → `@tokenlens/http security/token-compare`(R3;v1 注释即预言此合并)     |
| **tests**/receiver.test.ts | 218  | 拆分       | —        | batcher 段→observability(前波);HTTP 段→本包 real 测试;单测为新增规格   |

## 4. API 对照

| 旧签名                                         | 新签名                                   | 变化理由            |
| ---------------------------------------------- | ---------------------------------------- | ------------------- |
| `createReceiverApp({db,store,token?,batcher})` | 同形(+可选 logger)                       | 仅内部演进          |
| `new SpanBatcher(store,opts)`                  | `createSpanBatcher(store,opts)`          | observability G5    |
| `DecodeError` instanceof → 400                 | 流动错误 → onError 合成目录 → 400        | R2/G6               |
| `timingSafeEqual`(本地)                        | `timingSafeTokenEqual`(@tokenlens/http)  | R3/挂账#3           |
| `loadTraceReceiverEnv()`(core)                 | `loadTraceReceiverConfig()`(app config)  | R4/R5/R6;env 归 app |
| `initOtel({authToken 回落 env})`               | 无 authToken(接收端自身不推送)           | G2 已裁决           |
| 手写 shutdown 样板                             | `createShutdown({closeables:[batcher]})` | R7                  |

## 5. 测试迁移矩阵

| 旧测试(HTTP 面段)                             | 新去处                        | 动作                              |
| --------------------------------------------- | ----------------------------- | --------------------------------- |
| A9 bodyLimit 9MB 拒绝                         | receiver.real #1              | 移植(断言不变:∈[413,400] 且 ≠202) |
| token 门控(无/错 401,对 202)                  | receiver.real #2 + 单测鉴权门 | 移植+扩展(401 信封码断言)         |
| protobuf 415/坏 JSON 400/缺 resourceSpans 400 | receiver.real #3 + 单测媒体门 | 移植+码演进断言(R1/R2)            |
| 端到端 POST→flush→点查(userId=7)              | receiver.real #4              | 移植(vi.waitFor 排空节奏不变)     |
| SpanBatcher 段 2                              | observability tracing-ingest  | 前波已迁,本波删除不重迁           |

**删除的旧用例**:无(HTTP 面段全部迁入;batcher 段为前波已迁,非本波删除)。

## 6. 回滚方案

- **落地提交:8ee81f1(首波)+ 本文件所在提交(P5 返工:R10 pingDb 闭包 + 架构测试 +
  冒烟记录)**——revert 两提交即整体还原(含 http 包 +2 目录码与 token-compare,
  加法变更,revert 无残留引用)。
- 全新 app、旧仓只读不动;无 DDL、无 schema、无对外契约变更(/v1/traces 信封码变化
  仅在 v2 首次部署面发生,v1 生产进程不受影响——两仓独立部署)。
- bun.lock 不随本波提交(混并行会话条目,见 IMPLEMENTATION §5)。

## 7. 验收(全部满足才算完成)

- [x] 四门全绿:typecheck OK / oxlint 0-0 / 34 单测 + 4 真 PG / build(esm+sourcemap);
      覆盖率 lines 100 / branches 92.59 / functions 100 / statements 100 ≥ 90/85/90/90
      (src/index.ts 进程入口排除,vitest.config 口径申报)
- [x] §1 行为规格逐项核销(鉴权门 3/媒体门 4/载荷门 2/接收与指标 3 + real 4)
- [x] R6 回归用例通过(生产缺令牌 fail-fast——v1 恒不触发的闸门真实生效)
- [x] R10/P5 边界架构测试锁定(composition 只在 assembly、Db 类型不入 app.ts、
      禁 src 深导入;§5.5 机器验证 4 用例)
- [x] 挂账#3 兑现:token-compare 合一入 @tokenlens/http(4 用例语义锁)
- [x] http 包目录封闭 15 码 + status 修正表 401/415(catalog/render 测试同步)
- [x] **进程冒烟双形态**(铁律 17):bun 源码形态与 `node dist/index.js` 产物形态各
      readyz 200 / 无错令牌 401 / 415 信封 / 202→定时 flush→PG 点查(request_id+user_id=7
      提升列命中)/ SIGTERM draining→drained 正常退出;冒烟数据自清
- [x] turbo 管线 filter 本 app+http+依赖面全绿;仓库存量失败(identity typecheck/
      db 封闭测试)为并行会话在途工作,与本波无涉(未触碰其文件)
