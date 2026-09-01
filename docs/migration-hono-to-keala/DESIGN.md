# DESIGN — Hono → keala HTTP 层迁移（设计基线）

状态：**定稿**（2026-09-01）。分支 `refactor/hono-to-keala`。
关联：IMPLEMENTATION.md（施工图）、MIGRATION.md（API 对照与验收）。

## 1. 目标与非目标

**目标**：把 Tillgate 的 HTTP 层从 Hono 4.13 迁移到 keala 0.5.1（自研、npm 发布、
零依赖、ESM-only），保持全部既有测试语义等价（旧测试 = 行为规格），并以同机 A/B
基准量化迁移前后性能，产出可信报告。

**非目标**：

- 不改业务行为、不改 DTO、不改错误目录文案、不改数据库 schema；
- 不迁移 Next.js 前端（admin/client 不依赖 hono）；
- 不引入 keala 特有而 Hono 时代没有的新能力（sink/ws/静态文件/自带 cors 等），
  协议栈保持既有自研中间件（corsPreflight/securityHeaders/bodyParserLimit 等）；
- 不做 Hono 行为模拟层（见 §4 分歧裁决）。

## 2. 外部契约

HTTP 契约由三部分构成，迁移必须逐项保持或显式落档分歧：

1. **路由表**：全部路径、方法、路径参数形态不变（keala 与 Hono 同用 `:name` 语法；
   admin-api RBAC 绑定表存储的 `:param` 路径契约因此无需迁移数据）。
2. **响应与错误封套**：成功路径的 JSON 形态、`errorHandler` 的错误封套、状态码、
   错误头不变。错误转换从 Hono `app.onError` 改为最外层 keala 中间件
   （keala 的 `onError` 是事件监听器，不产生响应——见 MIGRATION §2）。
3. **请求读取**：body/query/header/param/cookie 读取语义等价；差异（重复 query
   键、尾斜杠、405）逐条落档 MIGRATION §4。

## 3. 内部问题域：keala 集成架构

收口原则沿用仓库现状：**`@tillgate/http` 是框架耦合的唯一收口点**。

- `packages/http` 定义面向本仓库的类型与工具：

  | 导出 | 作用 |
  |---|---|
  | `App` | `Application & { request(input, init?) }`——`withRequest()` 挂载的测试/装配糖 |
  | `withRequest(app)` | 给 keala app 实例挂 `request()`（内部 `new Request` + `handle`），全仓 580 处 `app.request` 调用零改动 |
  | `Middleware<C>` | `(c: C, next) => Promise<Response \| void>` |
  | `ContextOf<V>` | `Context & { state: V }`——替代 Hono `Env` 泛型的类型收窄 |

- **Env/Variables → `c.state`**：Hono `c.set('auth', v)`/`c.get('auth')` 改为
  `c.state.auth = v`，读取端用 `ContextOf<{ auth: Auth }>` 收窄类型。禁止散落
  `as` 断言——每 app 定义一次自己的 Context 别名（如 `gateway` 的 `GwContext`）。
- **body 解析**：每个 app 的协议栈在路由之前 `app.use(createBodyParser())`
  （keala 插件，惰性、有界、memo 单次读取）；`c.req.json()` 等签名不变。
- **校验**：保留自研 `jsonBody(schema)`/`query(schema)`（错误走既有
  `validation_failed` 目录封套），不换用 keala `validator`（其 400 文案是 keala
  自己的，会破坏错误契约）。解析结果落在 `c.state.validJson`/`c.state.validQuery`，
  读取用 `jsonBodyOf<T>(c)`/`queryOf<T>(c)`。
- **服务启动**：`serveApp` 改为 `app.handle(request, { server: bunServer })`，
  `idleTimeout` 等运维参数不变；trusted-client-ip 的 Bun 注入从
  `c.env.server` 改为 `c.runtime.server`。

## 4. 方向性裁决（用户裁决 + 已接受分歧）

| # | 裁决 | 依据 |
|---|---|---|
| D1 | keala 以 npm `keala@^0.5.1` 引入，不用本地 file: 链接 | 用户裁决（可复现/CI 友好） |
| D2 | 接受 keala 三处路由行为分歧（405+Allow、非严格尾斜杠、静态段恒优先），逐条落档 MIGRATION §4 | 用户裁决 |
| D3 | 580 处 `app.request` 测试调用零改动，经 `withRequest()` 适配 | 用户裁决（授权按性能与架构定夺；两方案生产路径相同，收口优于散落） |
| D4 | 不使用 keala 自带 cors/etag/compress/logger 等中间件替换自研协议栈 | 保持行为等价，迁移最小面 |

## 5. 并发与性能预算

- **吞吐**：迁移后真实 app（gateway 探针 + 代表性 JSON 路径）吞吐不得低于 Hono
  基线 ± 噪声带（keala 自有 bench 声称与 Hono 1.00x 统计平价；本迁移的预期结论
  是「平价或更优」，任何 >5% 的回归视为阻断项）。
- **尾延迟**：p99 不得劣化超过噪声带；SSE 流式路径首字节时间（TTFT）单独测量。
- **内存**：空闲 RSS 与 20 分钟饱和平台不高于基线 +10%。
- **冷启动**：不劣化（keala 零依赖、惰性 node 内置加载预期持平或更优）。

## 6. 风险面

1. `packages/billing` 计费链路经由 gateway 请求路径触发——迁移后必须跑
   billing 相关 e2e（隔离 schema 装置）确认资金路径无回归。
2. SSE 字节透传（`new Response(ReadableStream)` + otel 中间件包裹
   `c.res.body`）是最高风险点：keala 的提交后重写语义（rule-4 重建）需经
   e2e 流式旅程验证。
3. keala ESM-only：仓库全 ESM + Bun，无 CJS 消费方（已核对）。
4. `@hono/node-server` 在 e2e 是**未声明依赖**（bun.lock 惰性解析）——迁移中
   一并替换为 `keala/node`，消除隐式依赖。
