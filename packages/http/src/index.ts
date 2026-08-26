/**
 * @tillgate/http 公共出口——纯 HTTP/Hono 基础工具（DESIGN.md §2）。
 * 出口面有意维护：错误渲染出口（@tillgate/errors 第一消费者）、本地化、
 * 校验、分页、可信网络提取、请求上下文、幂等键、安全件。
 */

// ---- 错误：http 自有目录 + 渲染出口 + Hono onError ----
export {
  HttpErrors,
  GENERIC_INTERNAL_MESSAGE,
  GENERIC_UNAVAILABLE_MESSAGE,
} from './errors/catalog';
export {
  renderError,
  CATEGORY_STATUS_DEFAULTS,
  type FaceOverride,
  type RenderOptions,
  type RenderedError,
} from './errors/render';
export { errorHandler, type ErrorHandlerDeps, type ErrorLogger } from './errors/handler';
export { pgRejection } from './errors/sqlstate';
export { errorBody } from './errors/render';

// ---- 校验 / 参数 ----
export { jsonBody, query } from './validation/zod-validator';
export { intParam } from './validation/int-param';

// ---- 分页：容错解析 + 列表 query 组合基底 ----
export {
  PAGE_SIZE_MAX,
  PAGE_SIZE_DEFAULT,
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
  paginateQuery,
  type PaginationParams,
  type PaginatedResult,
} from './pagination/page';
export {
  sortOrderSchema,
  sortQuerySchema,
  searchQuerySchema,
  escapeLike,
  listQuerySchema,
} from './pagination/list-query';

// ---- 幂等 ----
export { operationId } from './idempotency/operation-id';

// ---- 网络：可信代理感知的客户端 IP + Bun 原生服务适配 ----
export {
  trustedClientIp,
  socketAddressFromContext,
  clientIpFromContext,
  type TrustedClientIpInput,
} from './network/trusted-client-ip';
export { serveApp, type AppServer, type ServeAppOptions } from './network/serve-app';

// ---- DB 并发预算门（公网 ingress 通用） ----
export {
  dbBudgetMiddleware,
  suggestDbBudget,
  type DbBudgetOptions,
} from './middleware/db-budget';

// ---- 请求上下文 ----
export { requestIdMiddleware } from './request-context/request-id';

// ---- 安全件：一次性密钥 + 常量时间比较 + 协议三件套 ----
// api-key/app 凭证生成器已随消费者迁入 @tillgate/accounts(C5/D3)
export { generateRedeemCode, maskUpstreamKey } from './security/secrets';
export { timingSafeTokenEqual } from './security/token-compare';
export {
  securityHeaders,
  corsPreflight,
  bodyParserLimit,
  type CorsConfig,
} from './security/protocol';

// ---- 本地化：Accept-Language 协商内核 ----
export {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  htmlLang,
  parseAcceptLanguage,
  resolveLocale,
  localeFromContext,
  type Locale,
} from './errors/locale';
