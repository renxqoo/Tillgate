import { validator } from 'hono/validator';
import { z } from 'zod';

/**
 * 校验错误（统一格式：details 数组，每项 {path, reason}）。
 * 由 app.onError 统一映射成 400 响应。
 */
export class ValidationError extends Error {
  constructor(
    public readonly details: Array<{ path: string; reason: string }>,
    options?: { message?: string },
  ) {
    super(options?.message ?? 'validation error');
    this.name = 'ValidationError';
  }
}

/**
 * JSON body 校验中间件 —— Hono validator + zod safeParse。
 * 校验失败抛 ValidationError（统一错误归一），成功后 c.req.valid('json') 得到 schema 输出类型。
 */
export function jsonBody<S extends z.ZodType>(schema: S) {
  return validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => {
        const field = issue.path.map(String).join('.');
        return { path: field ? `body.${field}` : 'body', reason: issue.message };
      });
      throw new ValidationError(details);
    }
    return parsed.data;
  });
}
