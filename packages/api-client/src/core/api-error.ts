/**
 * API 错误形态(框架无关):后端统一错误信封 { error: { message, code, details } } 的
 * 客户端表达。message/zh 渲染归消费方;本包抛出的 message 一律英文(铁律 18)。
 */

/** 后端标准错误结构(取自 { error: { message, code, details } }) */
export interface ApiErrorBody {
  message: string;
  code?: string;
  details?: unknown;
}

/** 非 2xx 响应抛出的错误;status 恒有,code/details 视信封而定 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly details: unknown;

  constructor(status: number, code: string | undefined, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
