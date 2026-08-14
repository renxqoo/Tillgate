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
  type ErrorLogger,
} from './errors.js';

export { csrfProtection, type CsrfOptions } from './csrf.js';

export {
  ValidationError,
  jsonBody,
  query,
} from './validation.js';

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
  sha256Hex,
  generateRedeemCode,
  generateApiKey,
  generateClientId,
  generateClientSecret,
  maskKey,
  maskUpstreamKey,
} from './secrets.js';

export { recordAudit, type AuditActor, type AuditInput } from './audit.js';

export { createRedis, Redis } from './redis.js';

export {
  ROUTE_CACHE_VERSION_KEY,
  authKeyCache,
  appStatusCache,
  balanceCache,
  bumpRouteCache,
  invalidateKeyAuthCache,
} from './cache.js';

export { operationId } from './idempotency.js';

export { loadRootEnvFile } from './load-env.js';
