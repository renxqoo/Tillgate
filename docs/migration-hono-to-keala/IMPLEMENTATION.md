# IMPLEMENTATION — Hono → keala 迁移施工图

状态：**定稿**（2026-09-01）。前置：DESIGN.md。审计证据：两个全量扫描
（Tillgate Hono 面 97 文件 + keala API 面），关键 API 语义逐一源码核验。

## 1. 审计结论（旧实现 = Hono 现状）

- Hono 耦合收口在 `packages/http`（9 个 src 文件），其余 packages 零耦合
  （架构测试强制，迁移后白名单同步改 keala）。
- 未使用的 Hono 面很大：`hono/streaming`、`hono/cors`、`hono/etag`、`hono/client`、
  serve-static、ContextVariableMap 增广均未用——SSE 全部是裸 `new Response(ReadableStream)`，
  对 keala 是好消息（直接透传）。
- 真实耦合面：`Env` 泛型 Variables（c.set/c.get）、`c.req.valid()`（39 处）、
  `hono/validator`（jsonBody/query 包装）、`hono/body-limit`、`hono/http-exception`、
  `hono/cookie`（仅 client-api oauth.ts）、`ContentfulStatusCode` 类型、
  `c.env.server`（Bun requestIP 注入）、`app.route()` 挂载、路径模式 `app.use(pattern, mw)`
  （gateway 预认证限流 / apiKey 按端点挂载、trace-receiver 按路径 body 限制）。
- 隐患（迁移中一并处理）：`@hono/node-server` 被 e2e 使用但未在任何 package.json 声明。

## 2. 逐模块裁决表

| 模块 | 裁决 | 说明 |
|---|---|---|
| packages/http 9 个 hono 文件 | 重写（保持导出面） | 中间件签名/类型换 keala，行为不变 |
| packages/http errors/catalog、render、sqlstate、pagination、secrets、token-compare | 不动 | 框架无关 |
| packages/http serve-app.ts | 复制+微修 | `fetch(request, env)` → `handle(request, { server })` |
| packages/http __test__ 8 个 hono 依赖测试 | 改写 | 断言语义不变，harness 换 `withRequest(new Keala())` |
| trace-receiver | 重写（1 文件） | 路径作用域 body 限制改内联 handler 链 |
| client-api 18 文件 | 重写（机械） | oauth.ts cookie 三处换 keala facade |
| admin-api 36 文件 | 重写（机械） | acl.ts `matchesPath` 不动（`:param` 语法双方一致） |
| gateway 12 文件 | 重写（谨慎） | otel SSE 包裹、apiKey 挂载、request-log `c.res` 读取为高危点 |
| e2e 5 个 `@hono/node-server` 文件 | 复制+微修 | `serve({fetch})` → `listen(app, 0)` + `ready()` 取真实端口 |
| apps/admin、client、worker | 不动 | 零 hono |

## 3. 路径模式 `app.use(pattern, mw)` 的映射（无路径作用域 use 的替代）

keala 只有全局 `app.use` 与 route 内联链。三处受影响，映射如下（行为等价）：

1. gateway `preauthIpRateLimitMiddleware('/v1/*', '/v1beta/*', '/oauth/token')`：
   改为全局注册，中间件内部按装配传入的路径前缀表短路（前缀表来自 app.ts 装配层，
   非底层常量）。
2. gateway 每个推理端点的 `apiKeyMiddleware`：移入对应 `Router.use()`
   （mount 作用域 = 原路径作用域）。
3. trace-receiver `bodyParserLimit('/v1/traces')`：内联进 `POST /v1/traces` 的
   handler 链（该路径仅一个路由）。

## 4. 阶段与门禁

每阶段独立 commit、四门全绿再进下一阶段（相关 workspace 的
typecheck/lint/build/test + 受影响 architecture 测试）：

| 阶段 | 范围 | 验证重点 |
|---|---|---|
| P1 | packages/http | 16 个测试文件改写后语义等价；architecture 白名单 hono→keala |
| P2 | trace-receiver | 最小垂直切片验证全部模式（errorHandler/bodyParser/request） |
| P3 | client-api | jsonBody/query 读取面、oauth cookie |
| P4 | admin-api | 31 路由、RBAC acl、ZodError 预翻译 |
| P5 | gateway + e2e | SSE 透传、otel 包裹、Bun 注入；e2e 默认门 + 冒烟 |
| P6 | 收口 | 移除全部 hono 依赖声明；根四门；`bun run format` |
| P7 | 基准 | main（worktree 基线）vs 分支，ABAB 多轮 + 20min 饱和 + 内存 + 冷启动 |
| P8 | 报告 | docs/benchmark-2026-09-01-hono-vs-keala.md + 核销 |

## 5. 测试迁移矩阵

| 旧测试形态 | 迁移 | 量 |
|---|---|---|
| `app.request(path, init)` | 零改动（`withRequest`） | ~580 处/42 文件 |
| `new Hono()` harness | `withRequest(new Keala())` | 13 处 |
| hono 类型导入 | `@tillgate/http` 类型别名 | 全部 |
| `HTTPException` 抛出断言 | `createError`/`c.throw` | packages/http handler 测试 |
| e2e `serve({fetch: app.fetch})` | `listen(app, 0)` + `ready()` | 5 文件 |

回归纪律：每个阶段先保证既有测试语义等价通过；发现 Hono→keala 行为差导致断言
必须改的，逐条登记 MIGRATION §4（分歧台账），禁止静默改断言。

## 6. 回滚方案

- 每阶段一个 commit，`git revert` 单阶段可回退；
- main 分支保持 Hono 不动（基准基线也从 main worktree 取）；
- keala 依赖声明最后阶段才从其余 workspace 移除 hono，中途任一阶段 hono/keala
  并存但不双轨（同一 app 内单一路径，未迁移 app 继续用 hono 直到其阶段完成）。
