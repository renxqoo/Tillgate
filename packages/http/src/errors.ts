import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { ERROR_REGISTRY, type KnownErrorCode } from './error-codes.js';

/**
 * 统一 HTTP 错误模型：所有业务错误以 throw HttpError 表达，
 * 由 errorHandler 归一成 { error: { message, code, details? } } 响应体。
 *
 * code 是主键：状态码与默认文案从集中注册表（error-codes.ts）推导，
 * 调用点不写状态码——新增错误码必须先登记（编译期强制 KnownErrorCode）。
 * 需要覆盖文案时传第二参；需要响应头（如 retry-after）传 headers。
 */

export class HttpError extends Error {
  /** HTTP 状态码（注册表单一真相） */
  readonly status: number;
  /** 响应头（如 { 'retry-after': '5' }；errorHandler 落到响应） */
  readonly headers?: Record<string, string>;
  /** 附加诊断信息（可选） */
  readonly details?: unknown;
  /** 下一步建议（网关对外信封用；管理/用户面忽略） */
  readonly suggestion?: string;

  constructor(
    /** 机器可读错误码（注册表键：管理/用户面大写蛇形、网关面小写蛇形） */
    public readonly code: KnownErrorCode,
    /** 覆盖默认文案（缺省用注册表 message） */
    message?: string,
    details?: unknown,
    headers?: Record<string, string>,
    suggestion?: string,
  ) {
    super(message ?? ERROR_REGISTRY[code].message);
    this.name = 'HttpError';
    this.status = ERROR_REGISTRY[code].status;
    this.details = details;
    this.headers = headers;
    this.suggestion = suggestion;
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
 * PG 约束/值错误 → 4xx 翻译表（原则：可预期拒绝不得伪装 500）。
 * drizzle 把 pg 错误包在 cause 链里，沿链找 5 位 PG SQLSTATE。
 * 已知冲突优先在路由层给业务语义（如 already_subscribed），此处是全局面兜底。
 */
const PG_CODE_MAP: Record<string, { code: KnownErrorCode; message: string }> = {
  '23505': { code: 'CONFLICT', message: 'Record already exists (unique constraint conflict)' },
  '23503': { code: 'INVALID_REFERENCE', message: 'Referenced resource not found' },
  '23514': { code: 'CONSTRAINT_VIOLATION', message: 'Operation violates data constraint' },
  '22001': { code: 'VALUE_TOO_LONG', message: 'Field value exceeds length limit' },
  '22P02': { code: 'INVALID_VALUE', message: 'Invalid field value format' },
  '22003': { code: 'VALUE_OUT_OF_RANGE', message: 'Field value out of range' },
};

// pgSqlState 实现下沉在 @ai-gateway/core（domain 层共用）；此处转发保持本包 API 稳定
import { pgSqlState as pgSqlStateImpl } from '@ai-gateway/core';
export const pgSqlState = pgSqlStateImpl;

/**
 * Hono onError 处理器：HttpError → 对应状态码 + 统一响应体 + 自带响应头；
 * 坏 JSON / PG 约束冲突 → 4xx；其余未知错误 → 500。
 * 挂载：app.onError(errorHandler(logger))
 */
export function errorHandler(logger?: ErrorLogger) {
  return (err: Error, c: Context) => {
    if (err instanceof HttpError) {
      if (err.headers) {
        for (const [key, value] of Object.entries(err.headers)) c.header(key, value);
      }
      return c.json(errorResponseBody(err), err.status as 200);
    }
    // 坏 JSON 请求体：hono validator('json') 解析失败抛 HTTPException(400,'Malformed JSON…')
    // （个别手写 c.req.json() 路径抛 SyntaxError）——客户端可预期错误必须在边界层
    // 翻译成 400，不得伪装成 500（原则：错误语义分级）
    if (
      err instanceof SyntaxError ||
      (err instanceof HTTPException && err.status === 400 && /JSON/i.test(err.message))
    ) {
      return c.json({ error: { message: 'Request body is not valid JSON', code: 'INVALID_JSON' } }, 400);
    }
    // 其余 Hono 内置 HTTPException（如 bodyLimit 413）：保留原状态码翻译成统一信封，
    // 不得兜成 500（可预期的拒绝不许伪装服务端故障）
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      const code: KnownErrorCode = err.status === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST';
      return c.json(
        { error: { message: ERROR_REGISTRY[code].message, code } },
        err.status as 200,
      );
    }
    const mapped = PG_CODE_MAP[pgSqlState(err) ?? ''];
    if (mapped) {
      return c.json(
        { error: { message: mapped.message, code: mapped.code } },
        ERROR_REGISTRY[mapped.code].status as 200,
      );
    }
    logger?.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return c.json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } }, 500);
  };
}
