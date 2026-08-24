# @tokenlens/http 迁移实现文档

> 状态：已完成（H1-H3 全部提交，四门 + 覆盖率全绿，行为核销清单逐项打勾）
> 基线：旧仓 `ai-getway/packages/http`（16 源文件 ~1.1k 行 + 11 测试 ~1.0k 行）+ 三个 app 的
> `middleware/{request-id,security,protocol}.ts` 漂移拷贝（requestId ×3、安全件 ×3）
> 目标：纯 HTTP/Hono 基础工具包（DESIGN.md §1；重构方案 §3.1/§5.1、ADR-0001/0002）
> 依赖：`@tokenlens/errors`（workspace）+ hono + @hono/node-server + zod——**v2 首个跨包依赖**

---

## 1. 审计结论

### 1.1 真 bug / 缺陷清单（v1）

| #   | 位置                  | 问题                                                                                                                                                          | 级别         | v2 处置                                                      |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------ |
| B1  | `errors.ts` PG 翻译   | 直接 import `@ai-gateway/core` 的 `pgSqlState`——http→core→pg 越界依赖链                                                                                       | 结构违规     | 探测函数注入（ADR-0002 D1）                                  |
| B2  | gateway `security.ts` | `bodyParserLimit` 藏 `DEFAULT_BODY_LIMIT_BYTES=10MiB` 默认值（零写死违例）；头注释写「400 提前拒绝」实际出 413（注释漂移）                                    | 零写死/文档  | maxBytes 必填；注释随统一件修正                              |
| B3  | gateway `security.ts` | `securityHeaders` 缺 `Cache-Control: no-store`（client/admin 均有——三拷贝已漂移）                                                                             | 安全头不一致 | 统一为 4 头全集（收紧方向，gateway 差异在 app 迁移单元生效） |
| B4  | 三 app CORS           | 方法集（gateway 无 PUT/PATCH/DELETE）、允许头（gateway 多 X-Request-Id）、Max-Age（gateway 86400）三处漂移且无参数化                                          | 重复+漂移    | `corsPreflight` 策略参数化（D2），defaults 取 console 形态   |
| B5  | `secrets.ts`          | `generateApiKey(prefix='sk_')` 默认值是部署可变值（v1 注释自认「须与网关识别端同一 env 值」）                                                                 | 零写死       | prefix 必填                                                  |
| B6  | `error-codes.ts`      | 151 业务码集中注册表：http 反向认识全部业务；admin/client 同名表六处映射漂移、25+ 未登记出站码、4 组大小写同码不同义（ADR-0001 §1 引 errors 包审计 E2/E3/E7） | 结构违规     | 整体重写为目录装配（ADR-0001 D1）；业务码段不迁              |
| B7  | `list-query.ts`       | `resolveOrderBy` 白名单用 `Object.hasOwn` 防原型链穿透（v1 复审 #2 修复）——该语义正确但随 drizzle 半边暂不迁移                                                | 记录         | 随归宿迁移单元复活（ADR-0002 D2）                            |

### 1.2 重复提取清单（D#）

| #   | 内容                                                                                                                                            | v2 归宿                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D1  | `requestIdMiddleware` ×3（client/gateway/admin-protocol）——逻辑逐字相同，仅 Env 泛型不同；gateway 注释最全（限流 ZSET member / 幂等键安全语义） | `request-context/request-id.ts`（注释取 gateway 全集） |
| D2  | `securityHeaders` / `corsPreflight` / `bodyParserLimit` ×3（client/gateway/admin-protocol）——B2-B4 漂移                                         | `security/protocol.ts`（参数化单实现）                 |
| D3  | drizzle 列表组装件（未来跨能力包重复风险）                                                                                                      | 不迁移，归宿待首个消费者裁决（ADR-0002 D2）            |

### 1.3 逐文件裁决总表

| v1 文件                                                           | 行数 | 裁决         | v2 去向 / 要点                                                                                                               |
| ----------------------------------------------------------------- | ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `errors.ts` HttpError/errorHandler/errorResponseBody              | 141  | **重构重写** | ADR-0001：HttpError+全局查表废除 → `errors/` 渲染家族（render/handler/catalog）；坏 JSON / Hono 4xx 兜底 / 未知 500 语义保持 |
| `errors.ts` PG_CODE_MAP + pgSqlState 转发                         | ~50  | 复制+微修    | `errors/sqlstate.ts`（六码表 + 探测注入，B1/ADR-0002）                                                                       |
| `error-codes.ts`（151 业务码注册表）                              | 258  | 不迁移       | 业务码段随能力包（P4）；边界码重写进 `errors/catalog.ts`（身份码改 `http.*` 点分小写，B6）                                   |
| `flow-error.ts`                                                   | 27   | 不迁移       | `BusinessError(code, context)` 已覆盖（kind 即身份码/context；ADR-0001 D1）                                                  |
| `validation.ts` jsonBody/query/ValidationError                    | 53   | 复制+微修    | `validation/`；失败改抛 `http.validation_failed`，details 数组 → context 平铺 `path→reason`                                  |
| `validation.ts` MONEY_MAX                                         | 1    | 不迁移       | 业务防呆上界归 billing 域（accounts/billing 迁移单元带走）                                                                   |
| `params.ts` intParam                                              | 14   | 复制+微修    | `validation/int-param.ts`；错误改 `http.invalid_path_param`                                                                  |
| `pagination.ts` 全部                                              | 73   | ✅ 复制      | `pagination/page.ts`（纯计算零瑕疵）                                                                                         |
| `list-query.ts` sort/search schema + escapeLike                   | ~35  | ✅ 复制      | `pagination/list-query.ts`（纯 query-string 半边）                                                                           |
| `list-query.ts` searchCondition/resolveOrderBy/buildList/countAll | ~155 | 不迁移       | drizzle+Db 耦合（ADR-0002 D2，B7 语义随迁）                                                                                  |
| `network.ts` 全部                                                 | 74   | ✅ 复制      | `network/trusted-client-ip.ts`（XFF 信任模型 + 进程级兜底语义原样）                                                          |
| `locale.ts` 全部                                                  | 63   | ✅ 复制      | `errors/locale.ts`（en                                                                                                       | zh 协商内核 + cookie 常量） |
| `idempotency.ts`                                                  | 26   | 复制+微修    | `idempotency/operation-id.ts`；错误改 `http.invalid_idempotency_key`                                                         |
| `secrets.ts` 除 encryptCurrent                                    | ~70  | 复制+微修    | `security/secrets.ts`；generateApiKey prefix 必填（B5）                                                                      |
| `secrets.ts` encryptCurrent                                       | 3    | 不迁移       | runtime `createCipher` 已接管（enc:v1 兼容）；http 不得依赖 runtime                                                          |
| `audit.ts`                                                        | 41   | 不迁移       | observability + 能力包（ADR-0002 D3）                                                                                        |
| `redis.ts` / `testing.ts` / `load-env.ts`                         | 124  | 不迁移       | runtime 已有更完整形态（createRedisClient / ./testing / P1 根配置）                                                          |
| `index.ts`                                                        | 99   | 重写         | 单入口 barrel（v1 的 ./network、./locale 子入口撤销——C9）                                                                    |
| apps ×3 `request-id.ts` / `security.ts` / `protocol.ts`           | ~300 | **重构合一** | D1/D2 → `request-context/` + `security/protocol.ts`                                                                          |

### 1.4 契约演进 / 缺口登记（C#）

| #   | 事项                                                                                          | 后果与归属                                                                          |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| C1  | 错误身份码改点分小写（`http.validation_failed`），v1 大写 wire 码（VALIDATION_ERROR）不再存在 | wire 投影归 app face override 表（P5 契约定稿）；前端迁移时映射                     |
| C2  | v1 `details: [{path, reason}]` → context 平铺 `{'body.name': reason}`                         | 同上，face 需要旧形状时在 face 层转换                                               |
| C3  | drizzle 列表件离场（含 INVALID_SORT_FIELD 白名单语义）                                        | 列表端点迁移单元（P4/P5）裁决归宿（ADR-0002 D2）                                    |
| C4  | `HttpError.headers` 自由响应头废除 → `retryAfterMs` 单语义（Retry-After 秒）                  | face 需要其他头时在 face onError 补（收窄面变窄是安全裁决）                         |
| C5  | `generateRedeemCode`（RC-）/`generateClientId`（app_）业务格式常量暂随 http/security          | accounts/billing 迁移单元带走（唯一真相随消费者走）                                 |
| C6  | `error-registry-grading.test.ts` 的全局分级守卫不再适用                                       | 分级纪律由 category 闭集结构保证（status 从 category 派生）；face 装配后的守卫随 P5 |
| C7  | v1 `errorHandler(logger?)` → `errorHandler(deps)` 对象参数                                    | 参数面扩展（sqlState/catalog/overrides）的必然演进                                  |
| C8  | `errors` 根包的 `ErrorRecord`/守卫已可直接消费；`normalizeError` 在 handler 内用于未知值      | 无缺口（首消费者就位即 ADR-0001 §4.2 次序）                                         |
| C9  | v1 `./network`、`./locale` 子入口撤销                                                         | 未来 api-client（P6）若需轻量入口，届时按真实消费面评审新增                         |

## 2. API 对照（v1 → v2）

| v1 签名                                                                                                          | v2 签名                                                                           | 变化理由                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `new HttpError(code, message?, details?, headers?, suggestion?)`                                                 | `HttpErrors.business(key, context?)` / 各机制件自有抛出口                         | ADR-0001 D1：身份/分类/文案单点来自目录定义；message 不可调用点覆盖（本地化前提） |
| `errorHandler(logger?)`                                                                                          | `errorHandler({ catalog?, overrides?, sqlState?, logger? })`                      | C7；PG 探测注入（B1）、face 装配（ADR-0001）                                      |
| `errorResponseBody(err, locale?)`                                                                                | `renderError(err, { locale?, catalog?, overrides? })`                             | 渲染输入从 HttpError 变 TokenlensError/unknown；status 由 category 派生           |
| `ERROR_REGISTRY` / `errorSpec` / `KnownErrorCode`                                                                | `HttpErrors`（http 目录）+ face `composeErrorCatalogs`                            | B6/ADR-0001 D1                                                                    |
| `localizeMessage` / `localizedSpecMessage`                                                                       | render 内按 `def.zh/def.message` 取用；`parseAcceptLanguage`/`resolveLocale` 原样 | 大小写双轨废除（ADR-0001 D2），本地化收进渲染单点                                 |
| `FlowError(kind, spec)`                                                                                          | `BusinessError(code, category, context)`                                          | kind 即身份码/context（ADR-0001）                                                 |
| `new ValidationError(details[])`                                                                                 | `HttpErrors.business('validation_failed', { [path]: reason })`                    | C2（context scalar-only 契约）                                                    |
| `new HttpError('INVALID_IDEMPOTENCY_KEY')`                                                                       | `HttpErrors.business('invalid_idempotency_key', { length })`                      | 同上                                                                              |
| `generateApiKey(prefix='sk_')`                                                                                   | `generateApiKey(prefix)`                                                          | B5 零写死                                                                         |
| `bodyParserLimit(maxBytes=10MiB)`（gateway）                                                                     | `bodyParserLimit(maxBytes)`                                                       | B2 零写死                                                                         |
| `corsPreflight(origins)`                                                                                         | `corsPreflight({ origins, methods, allowHeaders, maxAgeSeconds })`                | B4 三面漂移参数化；四要素必填注入（铁律 3，不藏 console 形态默认）                |
| `errorHandler` PG 直查                                                                                           | `errorHandler({ sqlState: pgSqlState })` 装配注入                                 | B1/ADR-0002                                                                       |
| `paginationQuerySchema` 等分页件                                                                                 | 原名原样                                                                          | 逐字等价                                                                          |
| `trustedClientIp` / `socketAddressFromContext` / `clientIpFromContext`                                           | 原名原样                                                                          | 逐字等价                                                                          |
| `sha256Hex` / `generateRedeemCode` / `generateClientId` / `generateClientSecret` / `maskKey` / `maskUpstreamKey` | 原名原样                                                                          | 逐字等价                                                                          |
| `operationId(c)`                                                                                                 | 原名                                                                              | 错误形态按 C1/C2 演进                                                             |
| `loadRootEnvFile` / `createRedis` / `recordAudit` / `createEphemeralRedis` / `encryptCurrent`                    | —（不迁移）                                                                       | §1.3 表                                                                           |

## 3. 拆分决策（引用审计证据）

1. **目录即边界**（DESIGN §1/目标树）：`errors/ validation/ pagination/ network/ request-context/
idempotency/ security/` 七目录 + 单入口 `index.ts`（C9）。
2. **错误家族八件分工**（errors/）：`catalog.ts`（HttpErrors 目录 + 出站通用文案常量）/
   `render.ts`（renderError 单一渲染路径 + CATEGORY_STATUS_DEFAULTS + override 机制）/
   `handler.ts`（Hono onError 边界翻译）/ `sqlstate.ts`（六码表）/ `locale.ts`（协商内核）——
   每文件一个动词（铁律 5）。
3. **status 解析链**：`override > HTTP_CODE_STATUS > CATEGORY_STATUS_DEFAULTS[category]`——
   http 自有码的 status 修正表为三码：`payload_too_large: 413`、`unauthorized: 401`、
   `unsupported_media_type: 415`（payload/凭证/媒体类型性质是协议语义分级，优先于 category 派生）；
   目录码封闭清单共 15 码（含 unauthorized、unsupported_media_type——与 DESIGN §3、
   `src/errors/catalog.ts` 一致）；其余码严格按 category 派生（C6 结构保证 v1 分级纪律）。
4. **安全件统一形态取超集**：securityHeaders 4 头（B3 收紧）；corsPreflight 参数化（B4）；
   bodyParserLimit 必填（B2）。gateway 的 10MiB/方法集差异回填发生在 app 迁移单元（P5），
   本包不保留 gateway 特例（单一形态，铁律 8）。
5. **`@tokenlens/errors` 为唯一内部依赖**：http 是其首个消费者（ADR-0001 §4.2）；
   workspace `development` 条件消费（exports 三条件，与全仓一致）。
6. **测试布局**：铁律 14——包根 `__test__/` 平铺，vitest include `__test__/*.test.ts`。

## 4. 测试计划（先于实现定稿）

`__test__/`（全部无需外部服务；无 *.real.test.ts）：

| 文件                  | 内容                                                                                                                                                                                                                                                                                          | v1 来源                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `catalog.test.ts`     | 目录码封闭性（装配校验/冻结/get/has/business 构造/category 分布）+ pg 六码身份 → category 断言 + payload_too_large 出站 413 修正                                                                                                                                                              | 新写（v1 注册表守卫 C6 的等价物）                                                     |
| `render.test.ts`      | business 三级 status 链（override > code 修正 > category 默认）；zh/en 文案取用；context 出站；infrastructure 503+通用文案+原码；defect/unknown 500+errors.unhandled+细节不外泄；retryAfterMs 透传                                                                                            | 移植 `errors.test.ts`/`error-locale.test.ts` 可迁移断言（重写面）                     |
| `handler.test.ts`     | TokenlensError→对应状态+信封；坏 JSON→400 `http.invalid_json`；合法 JSON 字段不符→400 validation_failed；Hono 4xx HTTPException→保留状态+invalid_request；413→payload_too_large；PG 六码（注入假探测，cause 链包裹）→4xx；ENOENT 等内部码不进翻译；未知→500+日志；retryAfterMs→Retry-After 头 | 移植 `errors.test.ts`+`bad-json.test.ts`+`pg-error-translation.test.ts`（探测改注入） |
| `locale.test.ts`      | parseAcceptLanguage 七例表；resolveLocale cookie 优先；isLocale/htmlLang                                                                                                                                                                                                                      | 移植 `error-locale.test.ts` 前半                                                      |
| `validation.test.ts`  | jsonBody 成功/失败（context 平铺 path→reason、body. 前缀）；query 折叠 string[]；intParam 正常/NaN/负数/0                                                                                                                                                                                     | 移植 `errors.test.ts` 校验两例；intParam 新写（v1 无测试）                            |
| `pagination.test.ts`  | schema 默认/强转/clamp/catch 五例；parsePagination/limitOffset/paginatedResult；sortQuerySchema/searchQuerySchema/listQuerySchema 组合与 extend；escapeLike                                                                                                                                   | 移植 `pagination.test.ts` 全部 + `list-query.test.ts` 纯半边                          |
| `network.test.ts`     | hops=0 忽略头；hops=1 伪造丢弃；hops=2 右数第二跳；XFF 不足回退 socket；进程级兜底稳定                                                                                                                                                                                                        | 移植 `trusted-client-ip.test.ts` 全部                                                 |
| `request-id.test.ts`  | 服务端生成 UUID；客户端 X-Request-Id 不被信任；响应回显                                                                                                                                                                                                                                       | 新写（v1 无包级测试——三拷贝仅在 app 测试间接覆盖）                                    |
| `idempotency.test.ts` | 合法键透传；含冒号/超长/非法字符→400；缺失→UUID                                                                                                                                                                                                                                               | 移植 `idempotency-key.test.ts` 全部                                                   |
| `secrets.test.ts`     | sha256 标准向量；RC-/ag 前缀+长度+字符集；app_/48hex；mask 边界（8/9 字符）                                                                                                                                                                                                                   | 移植 `secrets.test.ts` 全部                                                           |
| `protocol.test.ts`    | securityHeaders 4 头；CORS 放行/拒绝/预检 204/方法集参数；bodyLimit content-length 快路径 + 实际流计数 413（payload_too_large 信封）                                                                                                                                                          | 新写（v1 三拷贝无包级测试，D1/D2 的行为锁）                                           |

不迁移的 v1 测试：`error-registry-grading.test.ts`（C6）、`list-query.test.ts` drizzle 半边
（C3，随归宿迁移单元）、`pg-error-translation` 的探测实现细节（归 db 包测试）。

## 5. 实施顺序（每阶段独立提交 + 四门）

1. **H1 壳 + errors/**：package.json（workspace 依赖 @tokenlens/errors）/ tsconfig / vitest /
   `errors/{catalog,render,handler,sqlstate,locale}` + `index.ts`（先只出 errors 面）+ 测试
   （catalog/render/handler/locale）
2. **H2 机制件**：`validation/` + `pagination/` + `idempotency/` + index 扩面 + 测试
3. **H3 安全与上下文**：`network/` + `request-context/` + `security/`（secrets + protocol）+
   全量四门 + 行为核销清单逐项打勾

### 5.1 行为对照核销清单（H3 完成时逐项打勾）

- [x] 坏 JSON 体 → 400 `http.invalid_json`（W2 契约：客户端可预期错误不伪装 500）
- [x] zod 校验失败 → 400 `http.validation_failed`，context 含 `body.name`/`query.n` 前缀路径
- [x] Hono 4xx HTTPException（含 bodyLimit 413）→ 保留状态码 + 统一信封，不兜 500
- [x] PG 六码（探测注入）→ 23505 409 conflict、其余 400 invalid_input；ENOENT 不进翻译仍 500
- [x] 未知错误 → 500 `errors.unhandled` 通用文案 + logger.error（细节不外泄）
- [x] business status 三级链：override > payload_too_large 413 > category 默认表
- [x] infrastructure → 503 原身份码 + 通用文案；defect → 500 细节不外泄
- [x] retryAfterMs → Retry-After 秒头
- [x] Accept-Language：zh-CN/zh-TW→zh、en-US→en、fr→回落 en、q 值比较、空/缺失→en
- [x] 分页容错：page 0/-5/abc→1；page_size 999→100、xyz→20；字符串强转
- [x] listQuerySchema 组合基底 + 差异字段 extend；escapeLike 转义 % _ \
- [x] intParam：NaN/负数/0 → 400 `http.invalid_path_param`
- [x] XFF：hops=0 只信 socket；伪造首段丢弃；双层代理取右数第二跳；不足回退；进程级兜底稳定
- [x] requestId：服务端 UUID、不信任客户端头、响应回显
- [x] operationId：合法透传、冒号/超长/非法字符 400、缺失生成 UUID（T1 命名空间隔离语义保持）
- [x] secrets：sha256 向量、RC- 32×base32、prefix+40hex、app_+16hex、48hex、mask 8/9 字符边界
- [x] securityHeaders 4 头；CORS 白名单外静默放行无 CORS 头；预检 204；bodyLimit 双路径 413
