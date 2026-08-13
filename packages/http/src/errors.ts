import type { Context } from 'hono';

/**
 * 统一 HTTP 错误模型：所有业务错误以 throw HttpError 表达，
 * 由 errorHandler 归一成 { error: { message, code, details? } } 响应体。
 *
 * 目的：消灭散落各路由的 `c.json({ error: '字符串' }, 4xx)` 与
 * `{ error: { message, code } }` 两种格式混用的现状。
 */

export class HttpError extends Error {
  constructor(
    /** HTTP 状态码 */
    public readonly status: number,
    /** 机器可读错误码（大写蛇形，如 USER_NOT_FOUND） */
    public readonly code: string,
    message: string,
    /** 附加诊断信息（可选） */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 最小日志接口（pino logger 结构兼容，避免本包依赖 @ai-gateway/core） */
export interface ErrorLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** 组装统一错误响应体 */
export function errorResponseBody(err: HttpError): {
  error: { message: string; code: string; details?: unknown };
} {
  const error: { message: string; code: string; details?: unknown } = {
    message: err.message,
    code: err.code,
  };
  if (err.details !== undefined) error.details = err.details;
  return { error };
}

/**
 * Hono onError 处理器：HttpError → 对应状态码 + 统一响应体；未知错误 → 500。
 * 挂载：app.onError(errorHandler(logger))
 */
export function errorHandler(logger?: ErrorLogger) {
  return (err: Error, c: Context) => {
    if (err instanceof HttpError) {
      return c.json(errorResponseBody(err), err.status as 200);
    }
    logger?.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return c.json(
      { error: { message: '内部错误', code: 'INTERNAL_ERROR' } },
      500,
    );
  };
}
