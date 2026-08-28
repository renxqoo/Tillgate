import { UpstreamError } from './kinds';
import type { ErrorKind } from './kinds';

/**
 * 错误归一兜底：通用 HTTP 语义分类（非厂商知识，共享层零正则）。
 * 查表顺序：adapter 厂商结构表（各 adapter 内）→ 本 status 兜底 → 档案文本 pattern。
 * 兜底命中应尽量被 adapter 表覆盖；miss 时按下方矩阵给出保底 kind，不静默。
 */

/** 提取厂商错误信封中的原始码（OpenAI 形优先，兼容顶层 code） */
export function extractVendorCode(body: unknown): string | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  const e = asRecord(b.error);
  if (e) {
    if (typeof e.code === 'string') return e.code;
    if (typeof e.type === 'string') return e.type;
    if (typeof e.status === 'string') return e.status; // gemini 形：error.status = 'RESOURCE_EXHAUSTED'
  }
  return typeof b.code === 'string' ? b.code : undefined;
}

/** 提取错误信封中的 message（脱敏由外层出站做，此处保真） */
export function extractDetail(body: unknown): string | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  const e = asRecord(b.error);
  if (e && typeof e.message === 'string') return e.message;
  return typeof b.message === 'string' ? b.message : undefined;
}

/** Retry-After 头解析（秒或 HTTP-date；解析失败忽略） */
export function retryAfterMsOf(headers?: Record<string, string>): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined) return undefined;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec, 3600) * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 3_600_000));
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** status → kind 兜底矩阵（529 overloaded 单列；429 限流；401/403 凭据族；4xx 请求错误） */
export function statusKind(status?: number): ErrorKind {
  if (status === undefined) return 'network';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'upstream_error';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'invalid_api_key';
  if (status === 403) return 'insufficient_permissions';
  return 'invalid_request';
}

/**
 * status 兜底构造（adapter 未识别形状时的最终落点；vendorCode/detail/rawBody 保真）。
 */
// eslint-disable-next-line max-params -- 导出的错误构造 API（internal/stream、tableOrFallback 与测试多调用点），改对象参数放大跨模块 diff
export function statusFallbackError(
  status: number | undefined,
  body: unknown,
  rawBody?: string,
  headers?: Record<string, string>,
): UpstreamError {
  const kind = statusKind(status);
  return new UpstreamError({
    kind,
    status,
    vendorCode: extractVendorCode(body),
    message: extractDetail(body) ?? `upstream responded ${status ?? 'network error'}`,
    rawBody,
    retryAfterMs: kind === 'rate_limited' ? retryAfterMsOf(headers) : undefined,
    suggestion:
      kind === 'quota_exhausted'
        ? 'upstream quota or balance exhausted; top up or switch channel'
        : undefined,
  });
}

/**
 * 厂商表查表构造（adapter 侧唯一入口）：vendorCode 精确命中表 → kind；
 * 未命中落 status 兜底。机制位由 kinds 派生表决定，此处不可声明。
 */
export function tableOrFallback(input: {
  table: Record<string, ErrorKind>;
  status: number | undefined;
  body: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}): UpstreamError {
  const vendorCode = extractVendorCode(input.body);
  const kind = vendorCode !== undefined ? input.table[vendorCode] : undefined;
  if (kind === undefined) {
    return statusFallbackError(input.status, input.body, input.rawBody, input.headers);
  }
  return new UpstreamError({
    kind,
    status: input.status,
    vendorCode,
    message: extractDetail(input.body) ?? kind,
    rawBody: input.rawBody,
    retryAfterMs: kind === 'rate_limited' ? retryAfterMsOf(input.headers) : undefined,
  });
}
