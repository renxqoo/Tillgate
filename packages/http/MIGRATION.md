# @tokenlens/http 迁移文档（MIGRATION.md）

> 状态：已完成（H1-H3 全部提交，四门 + 覆盖率全绿；行为核销清单 17 项逐项打勾——
> [IMPLEMENTATION.md](./IMPLEMENTATION.md) §5.1；凭证生成器随消费者迁 accounts 后收口轮
> 100 用例全绿，git `f19043e`）
> 迁移单元：纯 HTTP/Hono 基础工具包——错误渲染出口、校验、分页、可信网络提取、请求上下文、
> 幂等键、安全件（不是垂直业务用例）
> 旧实现：`/Users/wrr/work/ai-getway/packages/http`（16 源文件 ~1.3k 行 + 11 测试文件
> ~0.9k 行 / 79 用例）+ 三个 app 各自漂移的 `middleware/{request-id,security,protocol}.ts`
> 拷贝（requestId ×3 / 安全件 ×3，~300 行——v2 口径见 IMPLEMENTATION §1.3 末行）
> 目标位置：`/Users/wrr/work/TokenLens-v2/packages/http`
> 关联：[DESIGN.md](./DESIGN.md)（设计基线，定稿）、[IMPLEMENTATION.md](./IMPLEMENTATION.md)
> （B#/D#/C# 编号出处）、[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)、
> [ADR-0002](../../docs/adr/0002-http-db-decoupling.md)

## 1. 行为规格基线

旧测试清单（11 文件 → 79 用例，`packages/http/src/__tests__/`）：

| 旧测试                             | 用例数 | 行为要点                                       |
| ---------------------------------- | ------ | ---------------------------------------------- |
| errors.test.ts                     | 7      | errorHandler 分派 / 校验失败 / 信封            |
| bad-json.test.ts                   | 2      | 坏 JSON 体 → 400（不伪装 500）                 |
| error-locale.test.ts               | 7      | Accept-Language 协商 / 大小写回退              |
| pagination.test.ts                 | 10     | 容错解析 / clamp / 分页组装                    |
| list-query.test.ts                 | 19     | 排序白名单 / 搜索 / LIKE 转义 / drizzle 组装件 |
| list-query-total-order.red.test.ts | 2      | 排序全序确定性（真实 PG 回归）                 |
| pg-error-translation.test.ts       | 3      | SQLSTATE → HTTP 映射                           |
| secrets.test.ts                    | 13     | sha256 向量 / RC-/sk_/app_ 格式 / mask 边界    |
| error-registry-grading.test.ts     | 5      | 注册表分级守卫                                 |
| idempotency-key.test.ts            | 4      | 键字符集 / 冒号拒绝 / 缺失生成                 |
| trusted-client-ip.test.ts          | 7      | XFF 信任模型矩阵                               |

**显式删除/改判的用例**（机制已裁决移除 ≠ 功能缺失，裁决出处标注）：

- `error-registry-grading`（5 例）：注册表模型废除（B6/ADR-0001 D1），分级纪律改由
  category 闭集 + status 修正表结构保证（C6）。
- `list-query` 的 drizzle 半边与 `list-query-total-order.red`（2 例）：drizzle/Db 耦合件
  不迁移（ADR-0002 D2 / C3），随首个列表端点消费者的迁移单元裁决归宿。
- `secrets` 中凭证生成器段（9 例）：api-key/app 凭证格式属消费者业务格式——随 accounts
  迁走（C5/D3，git `f19043e`），非删除而是归属迁移。

## 2. 审计结论（引用 IMPLEMENTATION.md §1，不重复抄写）

- **真 bug / 缺陷**：B1（PG 探测直 import core 越界依赖链）、B2（bodyParserLimit 藏 10MiB
  默认 + 注释漂移）、B3（securityHeaders 缺 Cache-Control 三拷贝漂移）、B4（三 app CORS
  三面漂移无参数化）、B5（generateApiKey 默认前缀是部署可变值）、B6（151 业务码集中注册表
  反向认识全部业务）、B7（resolveOrderBy 原型链穿透——语义正确，随 drizzle 半边暂不迁）。
- **重复提取**：D1（requestIdMiddleware ×3 合一，注释取 gateway 全集）、D2（安全件 ×3
  合一参数化）、D3（drizzle 列表组装件不迁移，归宿待消费者）。
- **契约缺口**：C1-C9（身份码点分小写、context 平铺、drizzle 件离场、自由头收窄、业务格式
  常量暂随、分级守卫改判、errorHandler 参数面、normalizeError 消费、子入口撤销）。

## 3. 逐模块裁决表

| 旧文件（行数）                                                 | 裁决         | 审计状态    | 动作                                                                                                                   |
| -------------------------------------------------------------- | ------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `errors.ts` HttpError/errorHandler/信封（141）                 | **重构重写** | B6/E 族     | `errors/` 渲染家族（catalog/render/handler）；错误体系按 ADR-0001 重写                                                 |
| `errors.ts` PG_CODE_MAP + 转发（~50）                          | 复制+微修    | B1          | `errors/sqlstate.ts`（六码表 + 探测注入，ADR-0002）                                                                    |
| `error-codes.ts`（258，151 码）                                | 不迁移       | B6          | 业务码段随能力包；边界码重写进 `errors/catalog.ts`（`http.*`）                                                         |
| `flow-error.ts`（27）                                          | 不移植       | 死代码      | `BusinessError(code, context)` 已覆盖                                                                                  |
| `validation.ts`（53）+ MONEY_MAX                               | 复制+微修    | —           | `validation/`；失败改抛 `http.validation_failed`，details → context 平铺；MONEY_MAX 归 billing                         |
| `params.ts`（14）                                              | 复制+微修    | —           | `validation/int-param.ts`；错误改 `http.invalid_path_param`                                                            |
| `pagination.ts`（73）                                          | ✅ 复制      | 纯计算      | `pagination/page.ts` 零瑕疵                                                                                            |
| `list-query.ts` 纯 query-string 半边（~35）                    | ✅ 复制      | —           | `pagination/list-query.ts`                                                                                             |
| `list-query.ts` drizzle 半边（~155）                           | 不迁移       | B7/C3       | 归宿待首个列表端点消费者（ADR-0002 D2）                                                                                |
| `network.ts`（74）                                             | ✅ 复制      | —           | `network/trusted-client-ip.ts`（XFF 信任模型 + 进程级兜底原样）                                                        |
| `locale.ts`（63）                                              | ✅ 复制      | —           | `errors/locale.ts`（en\|zh 协商内核 + cookie 常量）                                                                    |
| `idempotency.ts`（26）                                         | 复制+微修    | —           | `idempotency/operation-id.ts`；错误改 `http.invalid_idempotency_key`                                                   |
| `secrets.ts` 除 encryptCurrent（~70）                          | 复制+微修    | B5          | `security/secrets.ts`（prefix 必填）；凭证生成器后随 accounts 迁走（C5/D3），保留 generateRedeemCode / maskUpstreamKey |
| `secrets.ts` encryptCurrent（3）                               | 不迁移       | —           | runtime `createCipher` 接管（enc:v1）；http 不得依赖 runtime                                                           |
| `audit.ts`（41）                                               | 不迁移       | —           | observability + 能力包（ADR-0002 D3）                                                                                  |
| `redis.ts` / `testing.ts` / `load-env.ts`（124）               | 不迁移       | —           | runtime 已有更完整形态                                                                                                 |
| `index.ts`（99）                                               | 重写         | C9          | 单入口 barrel（`./network`、`./locale` 子入口撤销）                                                                    |
| apps ×3 `middleware/{request-id,security,protocol}.ts`（~300） | **重构合一** | B2-B4/D1/D2 | `request-context/` + `security/protocol.ts`（安全件统一形态取超集）                                                    |

## 4. API 对照

完整对照表见 IMPLEMENTATION §2（17 行）；关键行：

| 旧签名                                                               | 新签名                                                              | 变化理由                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| `new HttpError(code, message?, details?, headers?, suggestion?)`     | `HttpErrors.business(key, context?)` / 机制件自有抛出口             | ADR-0001 D1；message 不可调用点覆盖 |
| `errorHandler(logger?)`                                              | `errorHandler({ catalog?, overrides?, sqlState?, logger? })`        | C7；PG 探测注入（B1）               |
| `errorResponseBody(err, locale?)`                                    | `renderError(err, { locale?, catalog?, overrides? })` + `errorBody` | status 由 category 派生             |
| `ERROR_REGISTRY` / `errorSpec` / `KnownErrorCode`                    | `HttpErrors`（`http.*` 目录 15 码）+ face `composeErrorCatalogs`    | B6/ADR-0001 D1                      |
| `localizeMessage`（大小写双轨）                                      | render 内按 `def.zh/def.message` 取用                               | ADR-0001 D2（E7 消解）              |
| `generateApiKey(prefix='sk_')`                                       | （随 accounts 迁走，prefix 必填）                                   | B5 零写死 + C5/D3 唯一真相随消费者  |
| `bodyParserLimit(maxBytes=10MiB)`                                    | `bodyParserLimit(maxBytes)` 必填                                    | B2                                  |
| `corsPreflight(origins)`                                             | `corsPreflight({ origins, methods, allowHeaders, maxAgeSeconds })`  | B4 三面漂移参数化，四要素必填       |
| `paginationQuerySchema` / `trustedClientIp` / `escapeLike` 等机制件  | 原名原样                                                            | 逐字等价                            |
| `loadRootEnvFile` / `createRedis` / `recordAudit` / `encryptCurrent` | —（不迁移）                                                         | §3 表（各归 runtime/observability） |

## 5. 测试迁移矩阵

| 旧测试                                                     | 新去处                                                                           | 动作                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| errors.test.ts（7）                                        | `render.test.ts` + `handler.test.ts`                                             | 改写（重写面的差异逐条入 API 对照，新测试锁定）                     |
| bad-json.test.ts（2）                                      | `handler.test.ts`                                                                | 移植（400 `http.invalid_json` 语义不变）                            |
| error-locale.test.ts（7）                                  | `locale.test.ts`（协商内核）+ render zh 取用                                     | 移植（大小写回退段随 D2 废除删除）                                  |
| pagination.test.ts（10）                                   | `pagination.test.ts`                                                             | 移植全部                                                            |
| list-query.test.ts 纯半边                                  | `pagination.test.ts`（组合基底段）                                               | 移植                                                                |
| list-query.test.ts drizzle 半边（含 total-order.red 2 例） | —（不迁移）                                                                      | 删除：归宿待消费者迁移单元（C3）                                    |
| pg-error-translation.test.ts                               | `handler.test.ts`（探测注入假探测）                                              | 改写移植；探测实现细节归 db 包测试                                  |
| secrets.test.ts（13）                                      | `secrets.test.ts`（RC-/mask 段）                                                 | 移植；凭证生成器 9 例随 accounts 迁走（C5）                         |
| error-registry-grading.test.ts（5）                        | —                                                                                | 删除：分级由 category 结构保证（C6）                                |
| idempotency-key.test.ts（4）                               | `idempotency.test.ts`                                                            | 移植全部                                                            |
| trusted-client-ip.test.ts（7）                             | `network.test.ts`                                                                | 移植全部                                                            |
| （v1 无包级测试）                                          | `request-id` / `protocol` / `token-compare` / `catalog` / `architecture`（新写） | 新增规格：三拷贝合一件的行为锁（D1/D2）、目录封闭 15 码、导出面快照 |

## 6. 回滚方案

- H1（壳 + errors/）→ H2（机制件）→ H3（安全与上下文）每阶段独立提交、独立可 revert；
  全部为新增文件 + workspace 接线，不触碰旧仓（只读）。
- trace-receiver 波的加法变更（目录 +`unauthorized`/`unsupported_media_type` 两码 + status
  修正行 401/415、`timingSafeTokenEqual` 合一）随该 app 提交回滚，revert 无残留引用
  （其 MIGRATION §6 已列）。
- 凭证生成器外迁（`f19043e`）是加法迁移：revert http 侧删除需同步 revert accounts 侧新增
  （同迁移单元原子操作，铁律 10）。
- 无 DDL、无 schema、无对外契约变更（wire 投影归 app face，v1 生产进程不受影响）。

## 7. 验收（全部满足才算完成）

- [x] 四门全绿（typecheck / lint 0-0 / test 13 文件、收口轮 100 用例 / build）
- [x] 覆盖率 98.93 statements / 98.1 lines / 92.94 branches / 100 functions ≥ 90/85/90/90
      （git `40a796a` 实测口径），未调阈值
- [x] 行为对照核销清单 17 项逐项打勾（IMPLEMENTATION §5.1：坏 JSON / 校验失败 / Hono 4xx /
      PG 六码 / 未知 500 / status 三级链 / infrastructure / Retry-After / Accept-Language /
      分页容错 / intParam / XFF / requestId / operationId / secrets / 安全件 / bodyLimit）
- [x] B1-B6 修复各自有回归或注入点用例（用例名带缺陷编号，§10.1 纪律）
- [x] 目录码封闭 15 码与 status 修正表 401/413/415 由 `catalog.test.ts` 锁定
- [x] 不迁移清单（§3）各有归属标注，无孤儿
- 待核销（非本单元，显式挂账）：v1 大写 wire 码（`VALIDATION_ERROR` 等）的 face 投影表与
  `details` 旧形状转换归 app face 装配（C1/C2，P5 契约定案时裁决）；drizzle 列表件归宿
  待首个列表端点消费者（C3）。
