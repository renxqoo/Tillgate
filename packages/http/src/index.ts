/**
 * @ai-gateway/http — admin-api 与 client-api 共用的 Hono REST 组件层。
 *
 * 分层约定：
 *   - 错误：HttpError + errorHandler（统一 {error:{message,code,details?}} 响应体）
 *   - 校验：jsonBody / query + ValidationError
 *   - 分页：paginationQuerySchema / parsePagination / limitOffset / paginatedResult / paginateQuery
 *   - 密钥：sha256Hex / generate*（充值码/Key/App secret）+ maskKey / maskUpstreamKey
 *   - 审计：recordAudit（actor: admin/user/system）
 *   - 基础设施：createRedis + 网关缓存键/失效操作 + operationId + loadRootEnvFile
 */

export {
  HttpError,
  errorHandler,
  errorResponseBody,
  pgSqlState,
  type ErrorLogger,
} from './errors.js';
export {
  ERROR_REGISTRY,
  errorSpec,
  type ErrorSpec,
  type KnownErrorCode,
} from './error-codes.js';

export { csrfProtection, timingSafeTokenEqual, type CsrfOptions } from './csrf.js';

export {
  ValidationError,
  jsonBody,
  MONEY_MAX,
  query,
} from './validation.js';

export { intParam } from './params.js';

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
} from './pagination.js';

export {
  sortOrderSchema,
  sortQuerySchema,
  searchQuerySchema,
  escapeLike,
  searchCondition,
  resolveOrderBy,
  listQuerySchema,
  buildList,
  countAll,
  type SortInput,
  type Searchable,
  type ListQueryInput,
  type ListSortSpec,
  type BuildListOptions,
  type ListParts,
} from './list-query.js';

export {
  sha256Hex,
  generateRedeemCode,
  generateApiKey,
  generateClientId,
  generateClientSecret,
  maskKey,
  maskUpstreamKey,
  encryptCurrent,
} from './secrets.js';

export { recordAudit, type AuditActor, type AuditInput } from './audit.js';

export { createRedis, Redis } from './redis.js';

export {
  ROUTE_CACHE_VERSION_KEY,
  authKeyCache,
  appStatusCache,
  userProfileCache,
  balanceCache,
  bumpRouteCache,
  invalidateKeyAuthCache,
} from './cache.js';

export { operationId } from './idempotency.js';

export {
  trustedClientIp,
  socketAddressFromContext,
  clientIpFromContext,
  type TrustedClientIpInput,
} from './network.js';

export { loadRootEnvFile } from './load-env.js';
