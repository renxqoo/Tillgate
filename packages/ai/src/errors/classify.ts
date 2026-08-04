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

export interface ClassifyOptions {
  deadCredentialPatterns?: RegExp[];
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
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

/** HTTP 响应错误分类 */
export function classifyHttpError(
  status: number,
  body: unknown,
  opts: ClassifyOptions = {},
): UpstreamError {
  const patterns = opts.deadCredentialPatterns ?? DEFAULT_DEAD_CREDENTIAL_PATTERNS;
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
    return createUpstreamError({
      status,
      code: bodyCode ?? (status === 401 ? 'invalid_api_key' : 'forbidden'),
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
  return createUpstreamError({
    status,
    code: bodyCode ?? 'upstream_error',
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
