/**
 * 唯一出站渲染分派（ADR-0001 D1 + 内外分际；v1 errorResponseBody 的重写形态）：
 * 错误即数据——渲染 ErrorRecord 而不匹配错误类；status 解析链
 * face override > HTTP_CODE_STATUS（http 自有码修正）> CATEGORY_STATUS_DEFAULTS[category]。
 */
import {
  normalizeError,
  ROOT_ERROR_CODES,
  type BusinessRecord,
  type ErrorCatalog,
  type ErrorCategory,
  type ErrorContext,
} from '@tillgate/errors';
import { GENERIC_INTERNAL_MESSAGE, GENERIC_UNAVAILABLE_MESSAGE, HttpErrors } from './catalog';
import type { Locale } from './locale';

/** category → 默认出站 status（errors 包零 status 的 http 侧补位；DESIGN §2 契约细则） */
export const CATEGORY_STATUS_DEFAULTS: Readonly<Record<ErrorCategory, number>> = Object.freeze({
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403, // 401/403 分歧等 face 差异走 override
  quota_exhausted: 402,
  rate_limited: 429,
  unavailable: 503,
});

/** http 自有码的出站 status 修正（协议语义分级优先于 category 默认） */
const HTTP_CODE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  [HttpErrors.code('payload_too_large')]: 413,
  [HttpErrors.code('unauthorized')]: 401,
  [HttpErrors.code('unsupported_media_type')]: 415,
});

/** face 出站差异（ADR-0001 D1：个别码的出站投影——status 与 wire code） */
export interface FaceOverride {
  readonly status?: number;
  readonly code?: string;
}

export interface RenderOptions {
  readonly locale?: Locale;
  /** face 装配的全量目录（缺省仅 http 自有目录——包内机制件自用形态） */
  readonly catalog?: ErrorCatalog;
  readonly overrides?: Readonly<Record<string, FaceOverride>>;
}

/** 渲染产物：face onError 直接入信封；retryAfterMs 供 Retry-After 响应头渲染 */
export interface RenderedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly context?: ErrorContext;
  readonly retryAfterMs?: number;
}

function generic(messages: { readonly en: string; readonly zh: string }, locale: Locale): string {
  return locale === 'zh' ? messages.zh : messages.en;
}

/** 出站信封组装（errorHandler 与协议中间件共用——信封形状单一实现，DESIGN §4.2） */
export function errorBody(rendered: RenderedError): {
  error: { code: string; message: string; context?: ErrorContext };
} {
  const error: { code: string; message: string; context?: ErrorContext } = {
    code: rendered.code,
    message: rendered.message,
  };
  if (rendered.context !== undefined) error.context = rendered.context;
  return { error };
}

export function renderError(error: unknown, opts: RenderOptions = {}): RenderedError {
  const locale = opts.locale ?? 'en';
  const record = normalizeError(error);
  if (record.nature === 'business') return renderBusiness(record, locale, opts);
  if (record.nature === 'infrastructure') {
    // 环境故障：503 + 身份码保留（调用方可编程分派 unavailable）+ 通用文案（内部诊断不外泄）
    return {
      status: 503,
      code: record.code,
      message: generic(GENERIC_UNAVAILABLE_MESSAGE, locale),
    };
  }
  // 缺陷/未知：细节只进日志；出站统一 errors.unhandled + 通用文案（内外分际）
  return {
    status: 500,
    code: ROOT_ERROR_CODES.unhandled,
    message: generic(GENERIC_INTERNAL_MESSAGE, locale),
  };
}

function renderBusiness(
  record: BusinessRecord,
  locale: Locale,
  opts: RenderOptions,
): RenderedError {
  const catalog = opts.catalog ?? HttpErrors;
  const definition = catalog.get(record.code);
  if (definition === undefined) {
    // 目录 miss = face 装配缺陷（码未随包登记）：按缺陷渲染兜底，原码由 handler 落日志
    return {
      status: 500,
      code: ROOT_ERROR_CODES.unhandled,
      message: generic(GENERIC_INTERNAL_MESSAGE, locale),
    };
  }
  const override = opts.overrides?.[record.code];
  return {
    status:
      override?.status ??
      HTTP_CODE_STATUS[record.code] ??
      CATEGORY_STATUS_DEFAULTS[record.category],
    code: override?.code ?? record.code,
    message: locale === 'zh' ? definition.zh : definition.message,
    ...(record.context !== undefined ? { context: record.context } : {}),
    ...(record.retryAfterMs !== undefined ? { retryAfterMs: record.retryAfterMs } : {}),
  };
}
