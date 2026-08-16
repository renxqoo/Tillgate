import type { Context } from 'hono';
import type { GatewayReject } from './errors.js';

/**
 * 统一错误模型：全仓唯一 HttpError（packages/http，code 主键 + 注册表推导
 * 状态码/默认文案——见 error-codes.ts）。网关只保留 OpenAI 风格信封的渲染。
 */
export { HttpError } from '@ai-gateway/http';

/** OpenAI 风格错误类型（按 HTTP 状态映射，供下游 SDK 区分处理） */
function errorType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

/**
 * 构建错误信封 Response（onError 也复用，避免与路由两处拼装漂移）。
 */
export function errorEnvelope(
  c: Context,
  status: number,
  code: string,
  message: string,
  suggestion: string | undefined,
  requestId: string | null,
): Response {
  return c.json(
    {
      error: {
        message,
        type: errorType(status),
        code,
        param: null,
        request_id: requestId,
        suggestion: suggestion ?? null,
      },
    },
    status as 401,
  );
}

/**
 * GatewayReject → OpenAI 错误信封 + retry-after 头。
 * 管线步骤拒绝的唯一出站渲染入口（2026-08 统一错误体系）：描述符纯数据，
 * 渲染集中在此，出站脱敏/信封格式/头语义不可能在步骤里被绕过。
 */
export function renderReject(c: Context, r: GatewayReject): Response {
  if (r.retryAfterSec !== undefined) {
    c.header('retry-after', String(r.retryAfterSec));
  }
  return errorEnvelope(c, r.status, r.code, r.message, r.suggestion, readRequestId(c));
}

/** 安全读取 requestId（onError 可能在 requestId 中间件之前触发） */
function readRequestId(c: Context): string | null {
  try {
    return (c.var as { requestId?: string }).requestId ?? null;
  } catch {
    return null;
  }
}
