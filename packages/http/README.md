# @tillgate/http

> 纯 HTTP/Hono 基础工具:错误渲染出口、校验、分页、可信网络提取、请求上下文、幂等键、安全件——不拥有 wire schema、零 DB/业务依赖。
> 裁决:[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)(注册表归属)、[ADR-0002](../../docs/adr/0002-http-db-decoupling.md)(http↔db 解耦)

一句话:`@tillgate/errors` 根契约的**第一消费者**——category → 默认渲染 + face
override;只做 Hono 无关/通用的请求上下文、安全、分页与错误渲染,禁止进入 DB 查询、
业务错误映射与应用路由(wire schema 归各 app contracts)。

## 核心导出面

- 错误渲染出口:`renderError`(TillgateError → status/code/message/context 出站投影)、
  `errorHandler`(Hono onError:坏 JSON / HTTPException / 已分类错误 / PG SQLSTATE
  (探测注入) / 未知错误的边界翻译与兜底)、`CATEGORY_STATUS_DEFAULTS` + face override、
  `pgRejection`。
- `HttpErrors` 目录(`http.*` 命名空间):validation_failed / invalid_json /
  payload_too_large / invalid_idempotency_key / pg_* 等边界码。
- 校验:`jsonBody` / `query`(zod → Hono validator,失败抛目录业务错误,path→reason
  平铺进 context)、`intParam`。
- 分页:`paginationQuerySchema` / `parsePagination`(clamp 不报错)/ `limitOffset` /
  `paginatedResult`;列表 query 组合(`sortQuerySchema` / `searchQuerySchema` /
  `escapeLike`)。
- 网络:`trustedClientIp`(XFF 右数第 N 跳信任模型,代理跳数注入)。
- 请求上下文:`requestIdMiddleware`(服务端生成、响应回显)。
- 幂等:`operationId`(幂等键字符集校验)。
- 安全件:`generateRedeemCode` / `timingSafeTokenEqual` / `securityHeaders` /
  `corsPreflight` / `bodyParserLimit`。
- 本地化:Accept-Language 协商内核(`resolveLocale` / `parseAcceptLanguage`,en|zh,默认 en)。

## 目录结构

```
src/
├── errors/          # 目录 + renderError/errorHandler 渲染出口 + locale 协商 + sqlstate
├── validation/      # zod-validator(jsonBody/query) + intParam
├── pagination/      # page(容错解析/limit-offset/响应组装) + list-query(排序/搜索/LIKE 转义)
├── network/         # trustedClientIp(XFF 信任模型)
├── request-context/ # requestId 中间件
├── idempotency/     # operation-id 幂等键
├── security/        # 一次性密钥/常量时间比较/协议三件套(安全头/CORS/body 上限)
└── index.ts         # 唯一公共出口
```

## 装配

消费方:四个后端 app 的 HTTP 面——`apps/client-api` / `apps/admin-api` /
`apps/gateway` / `apps/trace-receiver`(errorHandler、校验/分页/安全件中间件);
`apps/admin` 前端列表参数约定与其同口径(不直接依赖)。

## 开发

```bash
cd packages/http
bun run typecheck && bun run lint && bun run test   # 无 real 门(纯工具,无 I/O 依赖)
```
