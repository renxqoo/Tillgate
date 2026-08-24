# @tillgate/http 设计基线（DESIGN）

> 状态：定稿（2026-08-23）
> 迁移单元：纯 HTTP/Hono 基础工具包——错误渲染出口、校验、分页、可信网络提取、请求上下文、
> 幂等键、安全件（不是垂直业务用例）
> 旧实现：`/Users/wrr/work/ai-getway/packages/http`（16 源文件 ~1.1k 行 + 11 测试 ~1.0k 行），
> 以及三个 app 各自漂移的 `middleware/{request-id,security,protocol}.ts`（requestId ×3 / 安全件 ×3）
> 目标位置：`/Users/wrr/work/Tillgate/packages/http`
> 关联：[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)（注册表归属）、
> [ADR-0002](../../docs/adr/0002-http-db-decoupling.md)（http↔db 解耦）、
> [project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3（http 目标树）、§5.1（http → 仅 errors）；
> 审计与裁决见同目录 [IMPLEMENTATION.md](./IMPLEMENTATION.md)

---

## 0. 原则

1. **纯 HTTP/Hono 工具，不拥有 wire schema**（结构方案 §3.1）：http 隐藏的复杂度是
   「Hono 无关/通用的请求上下文、安全、分页和错误渲染」；禁止进入：DB 查询、业务错误映射、应用路由。
2. **错误渲染第一消费者**（ADR-0001 §4.2 消费次序）：http 是 `@tillgate/errors` 根契约的
   第一个消费方——category → 默认渲染 + face override；业务码目录归能力包，http 永不 import 业务包。
3. **行为等价**：机制件（分页 clamp、XFF 信任模型、幂等键字符集、密钥格式、Accept-Language 协商）
   的 v1 测试是行为规格；错误体系重构（HttpError/注册表 → 三性/目录）按 ADR-0001 裁决**有意重写**，
   逐条列入 API 对照表。
4. **零写死**：可变值（CORS 策略、body 上限、API key 前缀、代理跳数、SQLSTATE 探测）一律注入必填；
   v1 的三处隐藏默认（gateway bodyLimit 10MiB、generateApiKey 'sk_'、PG 探测实现）全部清除。
5. **并发预算**：全部为请求内同步计算或常量装配；无跨请求状态、无定时器、无 I/O（secrets 的
   node:crypto 除外——随机数生成本身）。

## 1. 问题域

### 1.1 处理

- **错误渲染出口**：`renderError`（TillgateError → status/code/message/context 的出站投影）、
  `errorHandler`（Hono onError：坏 JSON / Hono 4xx HTTPException / 已分类错误按自身身份渲染 /
  PG SQLSTATE（探测注入，只兜未分类错误）/ 未知错误的边界翻译与兜底）、
  category → 默认 status 表、face override 机制、出站 Retry-After 渲染。
- **http 自有错误目录**：`HttpErrors`（`http.*` 命名空间）——http 机制件自身抛出/翻译的边界码
  （validation_failed、invalid_json、payload_too_large、invalid_idempotency_key、pg_* 六码、not_found 等）。
- **本地化**：Accept-Language 协商内核（en|zh，默认 en）+ 目录文案按 locale 取用。
- **校验**：zod schema → Hono validator 中间件（jsonBody/query），失败抛目录业务错误（context 平铺 path→reason）。
- **分页**：page/page_size 容错解析（clamp 不报错）、limit/offset 计算、标准分页响应组装；
  列表 query 组合 schema（排序/搜索词）与 LIKE 转义。
- **网络**：可信代理感知的客户端 IP 提取（XFF 右数第 N 跳信任模型）。
- **请求上下文**：requestId 中间件（服务端生成、响应回显）。
- **幂等**：idempotency-key 头解析（客户端键字符集与系统命名空间结构性隔离）。
- **安全件**：一次性密钥生成/哈希/脱敏；安全响应头；CORS 预检；请求体上限（双路径计数）。

### 1.2 明确不处理（写明归属，不留白）

| 不处理                                                                  | 归属                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 业务错误码定义（v1 注册表 ~190 业务码段）                               | 各能力包目录（P4 随包迁移）；app face 装配（ADR-0001 D1）                            |
| SQLSTATE 探测实现（cause 链爬取）                                       | `db` 包 `pgSqlState`（http 经 errorHandler 依赖注入消费，ADR-0002）                  |
| drizzle 列表组装件（searchCondition/resolveOrderBy/buildList/countAll） | 不移植；随首个列表端点消费者迁移单元裁决归宿（IMPLEMENTATION C3）                    |
| 业务 SQL / Repository CRUD / 审计持久化                                 | 能力包 adapters / `observability`（v1 audit.ts 不迁，C6）                            |
| Redis 连接与测试装置 / .env 加载 / 渠道密钥加密                         | `runtime`（createRedisClient、testing 子入口；loadRootEnvFile、createCipher——C4/C7） |
| OpenAI 错误信封 / 网关对外 wire 投影                                    | gateway app face（error-face 时用 override 表投影，P5）                              |
| wire contract / OpenAPI schema                                          | 提供 API 的 app（结构方案 §3.3）                                                     |
| `errors` 根契约（三性/category/目录/记录）                              | `@tillgate/errors`（http 单向依赖它，不重复定义）                                   |

## 2. 外部契约（v2 API，定稿）

```ts
import { HttpErrors, renderError, errorHandler, pgRejection,
         CATEGORY_STATUS_DEFAULTS, localeFromContext, parseAcceptLanguage,
         jsonBody, query, intParam, paginationQuerySchema, listQuerySchema, escapeLike,
         trustedClientIp, clientIpFromContext, requestIdMiddleware, operationId,
         generateRedeemCode, maskUpstreamKey, timingSafeTokenEqual, securityHeaders,
         corsPreflight, bodyParserLimit } from '@tillgate/http';

// ---- 错误：http 自有目录（http.* 命名空间；机制件唯一抛出口）----
HttpErrors.business('validation_failed', { 'body.name': 'expected string' });  // → BusinessError
HttpErrors.code('payload_too_large');                                          // → 'http.payload_too_large'

// ---- 渲染：category → 默认 status；face override 表达出站差异 ----
renderError(err, {
  locale: 'zh',                              // 缺省 en
  catalog: APP_ERRORS,                       // face 装配的全量目录（缺省仅 HttpErrors）
  overrides: { 'identity.session_invalid': { status: 401, code: 'unauthorized' } },
});  // → { status, code, message, context?, retryAfterMs? }
errorBody(rendered);                          // → { error: { code, message, context? } }（信封单一形状）

// ---- Hono onError：坏 JSON→400、Hono 4xx 保留、已分类错误按自身目录渲染、
//      PG SQLSTATE→4xx（探测注入，只兜未分类错误——带 PG cause 的业务错误不丢业务码）、未知→500 ----
app.onError(errorHandler({
  catalog: APP_ERRORS,                       // face 装配目录
  overrides?: FaceOverride 表
  sqlState?: pgSqlState,                     // @tillgate/db 注入（缺省无 PG 翻译）
  logger?: { error(obj, msg?) {} },          // 未知错误日志（缺省静默）
}));
pgRejection('23505');                        // → http.pg_unique_violation 业务错误 | null

// ---- 本地化：en|zh 协商内核（v1 语义原样）----
parseAcceptLanguage('zh-CN,zh;q=0.9');       // → 'zh'
resolveLocale(cookieValue, acceptLanguage);  // cookie 优先
localeFromContext(c);                        // → Locale

// ---- 校验 / 参数 ----
jsonBody(schema); query(schema);             // 失败 → http.validation_failed（context: path→reason 平铺）
intParam(c, 'id');                           // 非正整数 → http.invalid_path_param

// ---- 分页（容错：非法值回退默认、超上限 clamp；不抛错）----
paginationQuerySchema.parse({ page: '0' });  // → { page: 1, page_size: 20 }
listQuerySchema;                             // 分页 + q + sort_by/order 组合基底
escapeLike('100%');                          // → '100\\%'

// ---- 网络 / 上下文 / 幂等 ----
trustedClientIp({ headers, trustedProxyHops, socketAddress });  // XFF 右数第 N 跳
clientIpFromContext(c, { trustedProxyHops });
requestIdMiddleware();                       // 服务端 randomUUID + x-request-id 回显
operationId(c);                              // 头缺失→UUID；非法字符集→http.invalid_idempotency_key

// ---- 安全件 ----
// （api-key/app 凭证生成器 sha256Hex/generateApiKey/maskKey 等已随消费者迁入 @tillgate/accounts——C5/D3）
generateRedeemCode();                          // RC- <32×base32>（随 billing 波次迁走）
maskUpstreamKey(k);                            // 上游渠道 Key 脱敏
timingSafeTokenEqual(a, b);                    // 常量时间比较
securityHeaders;                             // 4 头统一形态（含 Cache-Control: no-store）
corsPreflight({ origins, methods, allowHeaders, maxAgeSeconds });  // 策略四要素必填注入（铁律 3）
bodyParserLimit(maxBytes);                   // maxBytes 必填；快路径 + 流式计数双路径 413
```

### 契约细则

- **渲染分派**（ADR-0001 D1 + 内外分际）：
  - `BusinessError` → 目录查定义（miss 按 defect 渲染并保留原码进日志）；status 解析链
    `face override > HTTP_CODE_STATUS（http 自有码修正表）> CATEGORY_STATUS_DEFAULTS[category]`；
    message 按 locale 取 `def.zh / def.message`；context 原样出站（scalar-only 契约保证安全）。
  - `InfrastructureError` → 503、code 保留身份码、文案用通用文案（内部诊断信息不外泄）。
  - `DefectError` / 未知值 → 500、`errors.unhandled` + 通用文案（细节只进日志）。
- **信封形状**：`{ error: { code, message, context? } }`——context 替代 v1 details（scalar 平铺）；
  app face 需要旧 `details: [{path, reason}]` wire 形状时在 face 渲染层转换（P5 契约定案时裁决）。
- **Retry-After**：`TillgateError.retryAfterMs` → `errorHandler` 出 `Retry-After`（秒，向上取整）；
  v1 `HttpError.headers` 自由头机制废除（收窄为唯一安全语义）。
- **CATEGORY_STATUS_DEFAULTS**（http 单点，errors 包零 status 的补位）：invalid_input 400 /
  not_found 404 / conflict 409 / forbidden 403 / quota_exhausted 402 / rate_limited 429 /
  unavailable 503；401/403 分歧等 face 差异走 override。
- **v1→v2 错误身份对照**（wire 投影由 face 决定，此处为 http 目录身份码）：
  VALIDATION_ERROR→`http.validation_failed`、INVALID_JSON→`http.invalid_json`、
  INVALID_REQUEST→`http.invalid_request`、INVALID_PARAM→`http.invalid_path_param`、
  INVALID_IDEMPOTENCY_KEY→`http.invalid_idempotency_key`、REQUEST_TOO_LARGE/PAYLOAD_TOO_LARGE→
  `http.payload_too_large`（出站 413）、not_found→`http.not_found`、
  CONFLICT→`http.pg_unique_violation`（PG 翻译族六码，见 ADR-0002）。

## 3. 词表与语义

- **http 目录码封闭清单**（装配期由 `defineErrorCatalog` 校验；新增码必须有机制抛点——铁律 4）：
  `validation_failed`、`invalid_json`、`invalid_request`、`invalid_path_param`、
  `invalid_idempotency_key`、`payload_too_large`（invalid_input 族，413 修正）、
  `unsupported_media_type`（invalid_input 族，415 修正）、`unauthorized`（forbidden 族，401 修正）、
  `not_found`、`pg_unique_violation`（conflict）、`pg_fk_violation`、`pg_check_violation`、
  `pg_value_too_long`、`pg_invalid_text`、`pg_numeric_out_of_range`（invalid_input 族）——
  共 15 码，与 `src/errors/catalog.ts` 一致。
- **Locale 闭集**：`en | zh`，默认 en；zh-CN/zh-TW/zh-HK 归并 zh，en-* 归并 en（v1 语义）。
- **XFF 信任模型**：`trustedProxyHops=0` 完全忽略代理头（直连防伪造默认）；`=N` 取右数第 N 跳；
  配错属部署责任（.env 注释约定随 app 配置）。
- **幂等键字符集**：客户端键 `/^[A-Za-z0-9_-]{1,64}$/`（结构性排除 `:`——系统自然键命名空间隔离，T1）。

## 4. 治理与稳定性

1. **依赖白名单**：`@tillgate/errors`（workspace）+ hono + @hono/node-server + zod；
   禁止 db / drizzle / ioredis / 业务包（架构测试与边界脚本就位后进 CI）。
2. **单一渲染路径**：所有出站错误（含 middleware 自拒 413）一律经 `renderError`——
   信封形状、本地化、override 只有一处实现。
3. **行为等价验证**：v1 测试迁移矩阵逐条核销（IMPLEMENTATION §5）；重写件（错误体系）
   的差异逐条列入 API 对照表并被新测试锁定。
4. **覆盖率**：与 errors/runtime 同门槛（lines/statements/functions 90、branches 85），
   `src/index.ts` 桶文件不计分母。

## 5. 预算

- 全部同步常量计算；目录/override/策略表装配期冻结一次，请求期 O(1) 查找。
- 无跨请求可变状态（v1 network.ts 的进程级 `unknown-<uuid>` 兜底是唯一例外——
  无 XFF 无 socket 环境的防污染兜底，语义保持并测试锁定）。
- errorHandler 异常路径无 I/O（logger 注入可选）；secrets 随机数生成 O(1)。
