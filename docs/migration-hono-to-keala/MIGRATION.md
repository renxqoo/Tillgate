# MIGRATION — Hono → keala API 对照与验收

状态：**已核销**（2026-09-01）。行为规格基线 = main 分支既有测试（1541+ 用例）。
基准结论：docs/benchmark-2026-09-01-hono-vs-keala.md。升级 0.5.1 → 0.6.1 见 §7。

## 1. API 新旧对照表

| Hono（旧） | keala（新） | 备注 |
|---|---|---|
| `new Hono<Env>()` | `new Keala()` + `type Ctx = ContextOf<{...}>` | Env 泛型 → state 收窄 |
| `c.set('k', v)` / `c.get('k')` | `c.state.k = v` / `c.state.k` | 读取端类型经 `ContextOf` |
| `app.route('/p', sub)` | `app.mount('/p', router)` | Router 有 verb 快捷方法 |
| `app.use(pattern, mw)` | 全局 use + 内联链 / `router.use` | 见 IMPLEMENTATION §3 |
| `app.onError(fn)` | 最外层 try/catch 中间件 `errorHandling` | keala onError 是事件监听器 |
| `app.notFound(fn)` | `app.notFound(fn)` | 同名同义（返回 Response 即提交） |
| `c.req.json()` 等 | `c.req.json()` 等（需先装 createBodyParser） | 惰性 memo，畸形 JSON 抛 400 |
| `c.req.param('id')` | `c.params.id`（可能 undefined） | 自行收窄 |
| `c.req.query()` | `c.query`（Record<string, string \| string[]>） | 重复键形态见 §4-4 |
| `c.req.query('k')` | `c.query.k` | |
| `c.req.header('k')` | `c.get('k')` | koa 风格请求头读取 |
| `c.req.raw` | `c.raw` | |
| `c.req.path` / `c.req.method` | `c.path` / `c.method` | |
| `c.req.parseBody()` | `await c.req.formData()` | urlencoded+multipart 同覆盖 |
| `c.req.valid('json')` | `jsonBodyOf<T>(c)`（读 `c.state.validJson`） | jsonBody 仍由 @tillgate/http 提供 |
| `c.req.valid('query')` | `queryOf<T>(c)` | 同上 |
| `c.json(body, status?, headers?)` | 同签名 | `c.json.bind(c)` 传参不变 |
| `c.text` / `c.body` 赋值 | 同名（koa 态） | |
| `c.header('k', v)` | `c.set('k', v)` | 响应头 |
| `c.res`（读/替换） | `c.res` 读；`c.body = new Response(...)` 重写 | 提交后写触发重建（rule-4） |
| `HTTPException` | `c.throw(status, msg, { expose, headers })` / `createError` | |
| `new Response(stream, SSE_HEADERS)` | 原样返回 | SSE 无框架耦合 |
| `getCookie/setCookie/deleteCookie`（hono/cookie） | `c.cookies.get/set`；删除 = `set(name, '', { maxAge: 0, path })` | 仅 client-api oauth.ts |
| `serveApp(app)` | `serveApp(app)`（内部 handle + runtime 注入） | 签名不变 |
| `app.request(path, init)`（测试） | 不变（`withRequest` 挂载） | D3 裁决 |
| `serve({ fetch: app.fetch })`（e2e, node） | `listen(app, 0)` + `await handle.ready()` | 顺带消除未声明依赖 |

## 2. 错误处理结构（关键差异）

Hono：`app.onError(handler)` 直接产生错误响应。
keala：`onError` 是日志监听器；错误响应由**最外层中间件** `try { await next() }
catch (e) { ... }` 产生。`@tillgate/http` 的 `errorHandler(deps)` 重写为
`errorHandling(deps)` 中间件（同一目录/覆盖/SQLSTATE 映射逻辑逐行保留），
`app.notFound` 保留原语义。中间件注册顺序：errorHandling 必须最先（最外层）。

## 3. 测试迁移矩阵与装置适配台账

| 装置适配 | 原因 |
|---|---|
| app 工厂统一 `return withRequest(app)` | 580 处 `app.request` 零改动（D3） |
| `new Hono()` → `withRequest(new Keala())`（13 处测试 harness） | 同上 |
| db-budget 单测 next 替身返回值断言（'served'）→ 完成性断言 | keala 中间件契约：next 只以 void 完成，不透传返回值 |
| jsonBody/query 经 `c.state.validJson/validQuery` + 类型化读取器 | keala 无 c.req.valid() |
| 断言 `res.headers.get('allow')` 新增 | 405 行为（§4-1）随 keala 引入 |
| 重复 query 键断言如存在需按 §4-4 核对 | query 形态差异 |

## 4. 行为分歧台账（已裁决 D2，客户端可见）

| # | 场景 | Hono（旧） | keala（新） | 影响面 |
|---|---|---|---|---|
| 1 | 命中路径、方法错 | 404 | **405 + Allow** | 测试断言更新；前端按状态码分支处需核对（经查前端走 api-client 错误封套，不分支 404/405） |
| 2 | 尾斜杠 `/v1/models/` | 404（strict） | 命中 `/v1/models` | 宽容化，无破坏性 |
| 3 | 同位静态段 vs 参数段 | 注册顺序优先 | 静态恒优先 | 本仓库无冲突对（已核对路由表） |
| 4 | 重复 query 键 | 后值覆盖（string） | 收集为数组（string[]） | 极端构造输入，既有测试无此形态 |
| 5 | OPTIONS（非 CORS 预检） | 404 | 200 + Allow | 无消费者 |
| 6 | HEAD 无显式路由 | 404 | 回落到 GET handler（无 body） | 探针仅用 GET，无影响 |
| 7 | 默认错误体 | onError JSON 封套 | errorHandling 中间件 JSON 封套（等价） | 需 e2e 验证 |
| 8 | 流式 413 信封 context | 含 max_bytes | 谎报头（声明小实发大）路径不含 max_bytes（keala readBodyLimited 错误不带限值）；声明超限与 chunked 预读路径均带 | 极端构造输入，信封 code/status/message 不变 |
| 9 | 已鉴权前缀的错误方法/未注册子路径 | app.use(path) 路径作用域先跑鉴权 → 401 | keala 鉴权域化在路由组——错误方法 405、未注册子路径 404 均不先经鉴权 | 仅泄露路径存在性；凭据/数据面无暴露 |
| 10 | 错误传播与中间件后置逻辑 | Hono compose 逐层捕获错误转响应——外层 next 后置代码照常执行 | keala（koa 语义）错误向上抛——外层 next 后置代码被跳过；静态响应头已前置 staged（requestId/securityHeaders），request-log 经 catch+finally 保持「记录一切」语义 | 实现层适配，客户端可见行为等价（错误响应仍带全部响应头） |

## 5. 验收清单

- [x] P1–P6 每阶段四门全绿（typecheck/lint 0-0/build/test）
- [x] 根四门：`bun run typecheck && bun run lint && bun run test && bun run build`
      （0.5.1 迁移收口与 0.6.1 升级后各一轮全绿）
- [x] e2e 默认门（gateway/security）：除 4 个 main 既有失败（§3 台账）外全绿；双形态进程冒烟通过
- [x] 双形态冒烟：源码形态与 build 产物形态各起 gateway 进程，探针/鉴权/真请求/SIGTERM/对账（process-smoke ✓）
- [x] `grep -r "from 'hono" apps packages` 零命中；hono 从全部 package.json 移除
- [x] 基准报告产出（P8）：docs/benchmark-2026-09-01-hono-vs-keala.md（业务路径 +2.7% 平价偏优；
      探针 −10%、body facade 微基准 −51.6% 已归因至 keala 上游可一行修复；饱和内存收敛平台 887MB）
- [ ] 分歧台账 §4 与实现一致，无静默断言改动

## 6. 挂账

| 项 | 处置 |
|---|---|
| keala `validator`/`cors`/`etag`/`compress`/`sink`/`ws` 等未采用能力 | 不移植（D4）；后续单独评估 |
| 重复 query 键数组形态 | 接受（§4-4）；如前端出现依赖单值语义的用例再收窄 |

## 7. 升级记录：keala 0.5.1 → 0.6.1（2026-09-01）

上游 0.6.x 消化了迁移复盘的部分发现（keala 仓 docs/DOGFOOD-R2.md 为裁决记录）。
本仓适配面（全部生产路径无行为变化，仅错误判别从 message 正则改为机器可读 code）：

| 上游变更 | 本仓动作 |
|---|---|
| `handle()` 恒 `Promise<Response>` 且不 reject（0.6.0，breaking） | `withRequest` 去掉冗余 `Promise.resolve` 包装；serve-app/e2e 装置签名本就兼容 |
| `Next`/`RouteHandler` 根导出（0.6.1） | 适配层 `Next` 改为再导出 keala 定义（形状同为 `() => Promise<void>`），消除自有副本漂移风险 |
| `HttpError.code` 字段 + body 错误带 `invalid_json`/`payload_too_large`（0.6.1） | `frameworkErrorResponse` 弃用 `/JSON/i` message 正则，改 `error.code` 匹配；`bodyParserLimit` 的 413 判别同步改 code；handler.test 合成错误用例改走 code 分支 |
| `readBodyLimited` declared 长度快路径原生 `arrayBuffer()` 单发读（0.6.1） | 无代码动作；性能收益由基准复测确认（见基准报告 0.6.1 增量节） |
| dev 链停滞警告（0.6.0 全局位 + 0.6.1 路由级位） | 无代码动作；开发环境中间件漏调 `next()` 的静默 404 陷阱（P0-1）自此有告警，生产/测试链路字节级不变 |
| 提交后改写响应体剥离旧 content-length 等体描述头（r8 修复，随 0.6.1 发布） | 无代码动作；otel SSE 接力（`c.body = new Response(relay, committed)`）的 wire 一致性自此由框架保证 |

上游否决/挂账项（与本仓分歧台账关系）：「json() 委托 raw.json()」被否决（拆 413
预算）——§4-8 及微基准差距按此维持；路径作用域 `use(pattern, mw)`（§4-9）、请求流
拦截点、注册面泛型、层数/内存平台 profile 均挂账上游，未落地前本仓适配层不变。
