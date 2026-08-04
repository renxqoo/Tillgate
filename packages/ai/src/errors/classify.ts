import { asRecord } from '../internal/util.js';
import type { UpstreamError } from '../types.js';

/**
 * 错误分类矩阵（ai-package.md §7.1）：一次分类同时驱动重试/熔断/死凭据三种机制
 *
 * | 上游表现        | code            | retryable | circuitTrip | deadCredential |
 * | 5xx            | upstream_error  | ✅        | ✅          |                |
 * | 网络/超时       | network/timeout | ✅        | ✅          |                |
 * | 429            | rate_limited    | ✅        | ❌          |                |
 * | 401 / 403      | invalid_api_key | ❌        | ❌          | ✅(按特征)      |
 * | 400 / 404      | invalid_request | ❌        | ❌          |                |
 */

/** 死凭据文本特征（可配置扩展） */
export const DEFAULT_DEAD_CREDENTIAL_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /invalid_api_key/i,
  /incorrect api key/i,
  /authentication failed/i,
  /unauthorized/i,
  /api key.*(invalid|incorrect|expired|not valid)/i,
  /认证失败/i,
];

/**
 * 额度/配额「永久」耗尽特征（429 但语义是账户余额耗尽，不可重试，需充值才恢复）。
 *
 * 与「窗口配额用尽」区分（后者可自动恢复，应判 rate_limited 可重试）：
 *   - MiniMax 2056（Token Plan 5h 窗口额度）：message 含「套餐/积分/用量上限」但 5h 后自动恢复 → 限流
 *   - OpenAI insufficient_quota / 账户余额不足：需充值才恢复 → quota_exhausted
 *
 * 因此 message 模式只匹配明确的「余额/billing/充值」语义，不匹配「套餐/积分/用量上限」
 * （那些可能是可恢复的窗口限制）。body code 精确匹配更可靠（优先）。
 */
export const DEFAULT_QUOTA_EXHAUSTED_PATTERNS: RegExp[] = [
  /insufficient.*(quota|balance|fund)/i,
  /(balance|fund).*(insufficient|low|empty)/i,
  /billing/i,
  /余额不足/,
  /余额.*(?:耗尽|用完|不足)/,
  /(?:耗尽|用完).*余额/,
  /账户.*(?:欠费|欠款)/,
  /请.*充值/,
  /top.*up/i,
];

/** 额度耗尽判定的 body code 集合（精确匹配，优先于文本特征） */
const QUOTA_EXHAUSTED_CODES = new Set([
  'quota_exhausted',
  'quota_exceeded',
  'insufficient_quota',
  'insufficient_balance',
  'insufficient_funds',
  'billing_required',
  'payment_required',
]);

export interface ClassifyOptions {
  deadCredentialPatterns?: RegExp[];
  quotaExhaustedPatterns?: RegExp[];
}

export function createUpstreamError(input: {
  status?: number;
  code: string;
  message: string;
  retryable: boolean;
  circuitTrip: boolean;
  deadCredential?: boolean;
  suggestion?: string;
  rawBody?: string;
}): UpstreamError {
  const err = new Error(input.message) as UpstreamError;
  err.status = input.status;
  err.code = input.code;
  err.retryable = input.retryable;
  err.circuitTrip = input.circuitTrip;
  err.deadCredential = input.deadCredential ?? false;
  if (input.suggestion !== undefined) err.suggestion = input.suggestion;
  if (input.rawBody !== undefined) err.rawBody = input.rawBody;
  return err;
}

function extractMessage(body: unknown): string | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  const e = asRecord(b.error);
  if (e && typeof e.message === 'string') return e.message;
  return typeof b.message === 'string' ? b.message : undefined;
}

function extractCode(body: unknown): string | undefined {
  const b = asRecord(body);
  if (!b) return undefined;
  const e = asRecord(b.error);
  if (e) {
    if (typeof e.code === 'string') return e.code;
    if (typeof e.type === 'string') return e.type;
  }
  return typeof b.code === 'string' ? b.code : undefined;
}

/** 401 恒为死凭据；403 需命中文本特征（可能是权限而非密钥问题） */
function isDeadCredential(status: number, message: string, patterns: RegExp[]): boolean {
  if (status === 401) return true;
  return patterns.some((p) => p.test(message));
}

/** 额度耗尽判定：body code 精确匹配，或 message 命中特征模式 */
function isQuotaExhausted(
  bodyCode: string | undefined,
  message: string,
  patterns: RegExp[],
): boolean {
  if (bodyCode && QUOTA_EXHAUSTED_CODES.has(bodyCode)) return true;
  return patterns.some((p) => p.test(message));
}

/** HTTP 响应错误分类 */
export function classifyHttpError(
  status: number,
  body: unknown,
  opts: ClassifyOptions = {},
): UpstreamError {
  const patterns = opts.deadCredentialPatterns ?? DEFAULT_DEAD_CREDENTIAL_PATTERNS;
  const quotaPatterns = opts.quotaExhaustedPatterns ?? DEFAULT_QUOTA_EXHAUSTED_PATTERNS;
  const message = extractMessage(body) ?? `upstream error (HTTP ${status})`;
  const bodyCode = extractCode(body);
  const rawBody = typeof body === 'string' ? body : undefined;
  const deadCredential = isDeadCredential(status, message, patterns);

  if (status >= 500) {
    return createUpstreamError({
      status,
      code: bodyCode ?? 'upstream_error',
      message,
      retryable: true,
      circuitTrip: true,
      suggestion: '上游服务异常，请稍后重试',
      rawBody,
    });
  }
  if (status === 429) {
    // 区分「限流（可重试）」与「额度耗尽（不可重试）」：
    // 部分供应商（如 MiniMax）把额度/配额耗尽也用 429 返回（code=rate_limit_error），
    // 但语义上是计费问题——重试无意义，只会浪费请求。按 body code/message 特征识别。
    if (isQuotaExhausted(bodyCode, message, quotaPatterns)) {
      return createUpstreamError({
        status,
        code: 'quota_exhausted',
        message,
        retryable: false, // 额度耗尽重试无意义（需充值/换渠道，而非退避）
        circuitTrip: false,
        suggestion: '渠道额度/配额已耗尽，请充值或更换渠道',
        rawBody,
      });
    }
    return createUpstreamError({
      status,
      code: bodyCode ?? 'rate_limited',
      message,
      retryable: true,
      circuitTrip: false,
      suggestion: '请求过于频繁，请稍后重试',
      rawBody,
    });
  }
  if (status === 401 || status === 403) {
    // 鉴权失败：code 归一为 invalid_api_key/forbidden（不用供应商 bodyCode——
    // DeepSeek 401 返回 invalid_request_error，但语义是 key 问题，应归一便于路由/换渠道判断）
    const authCode = status === 401 ? 'invalid_api_key' : 'forbidden';
    return createUpstreamError({
      status,
      code: deadCredential ? authCode : (bodyCode ?? authCode),
      message,
      retryable: false,
      circuitTrip: false,
      deadCredential,
      suggestion: '请检查渠道上游 API Key',
      rawBody,
    });
  }
  if (status === 400) {
    return createUpstreamError({
      status,
      code: bodyCode ?? 'invalid_request',
      message,
      retryable: false,
      circuitTrip: false,
      rawBody,
    });
  }
  if (status === 404) {
    return createUpstreamError({
      status,
      code: bodyCode ?? 'model_not_found',
      message,
      retryable: false,
      circuitTrip: false,
      suggestion: '模型不存在或已下线',
      rawBody,
    });
  }
  // 408 请求超时：上游收到但未及时处理，与 transport timeout 同语义（可重试 + 跳闸）
  if (status === 408) {
    return createUpstreamError({
      status,
      code: bodyCode ?? 'timeout',
      message,
      retryable: true,
      circuitTrip: true,
      suggestion: '上游响应超时，请稍后重试',
      rawBody,
    });
  }
  // 413 请求体过大：客户端问题，不重试不跳闸（与 invalid_request 同语义但 code 区分便于排障）
  if (status === 413) {
    return createUpstreamError({
      status,
      code: bodyCode ?? 'payload_too_large',
      message,
      retryable: false,
      circuitTrip: false,
      rawBody,
    });
  }
  // 未知状态码（4xx 非 400/401/403/404/408/413/429；或 3xx 异常等）：
  // 独立 http_error 分类，避免与真正的 5xx upstream_error 混淆（影响指标面板）
  return createUpstreamError({
    status,
    code: bodyCode ?? 'http_error',
    message,
    retryable: false,
    circuitTrip: false,
    rawBody,
  });
}

/** 传输层错误（未收到 HTTP 响应） */
export function classifyTransportError(kind: 'timeout' | 'network'): UpstreamError {
  if (kind === 'timeout') {
    return createUpstreamError({
      code: 'timeout',
      message: 'upstream request timed out',
      retryable: true,
      circuitTrip: true,
      suggestion: '上游响应超时，请稍后重试',
    });
  }
  return createUpstreamError({
    code: 'network',
    message: 'upstream network error',
    retryable: true,
    circuitTrip: true,
  });
}
