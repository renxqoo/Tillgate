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

/**
 * Query 参数校验中间件 —— GET 请求的 query string 版 jsonBody。
 * 把 string[] 折叠成 string（取首项），让单值 zod schema 直接校验 query。
 */
export function query<S extends z.ZodType>(schema: S) {
  return validator('query', (value) => {
    const flattened: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, string | string[]>)) {
      flattened[k] = Array.isArray(v) ? (v[0] ?? '') : v;
    }
    const parsed = schema.safeParse(flattened);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => {
        const field = issue.path.map(String).join('.');
        return { path: field ? `query.${field}` : 'query', reason: issue.message };
      });
      throw new ValidationError(details);
    }
    return parsed.data;
  });
}
