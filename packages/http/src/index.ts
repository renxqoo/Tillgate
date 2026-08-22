/**
 * @tokenlens/http 公共出口——纯 HTTP/Hono 基础工具（DESIGN.md §2）。
 * 出口面有意维护：错误渲染出口（@tokenlens/errors 第一消费者）、本地化、
 * 校验、分页、可信网络提取、请求上下文、幂等键、安全件。
 */

// ---- 错误：http 自有目录 + 渲染出口 + Hono onError ----
export { HttpErrors, GENERIC_INTERNAL_MESSAGE, GENERIC_UNAVAILABLE_MESSAGE } from './errors/catalog';
export {
  renderError,
  CATEGORY_STATUS_DEFAULTS,
  type FaceOverride,
  type RenderOptions,
  type RenderedError,
} from './errors/render';
export { errorHandler, type ErrorHandlerDeps, type ErrorLogger } from './errors/handler';
export { pgRejection } from './errors/sqlstate';

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
