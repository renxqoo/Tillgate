import { validator } from 'hono/validator';
import { z } from 'zod';
import { HttpError } from './errors.js';

/**
 * 请求校验组件：JSON body / query 的 zod 校验中间件，
 * 校验失败抛 ValidationError（HttpError，status 400，code VALIDATION_ERROR），
 * 由 errorHandler 统一映射。
 *
 * 不用 @hono/zod-validator：zod v4 classic API 下联合类型会导致 TS 重载报错。
 */

/** 金额/额度输入上界（¥10 亿）——与 numeric(38,18) 的安全余量无关，是业务面防呆上界 */
export const MONEY_MAX = 1e9;

export class ValidationError extends HttpError {
  constructor(public readonly details: Array<{ path: string; reason: string }>) {
    super('VALIDATION_ERROR', 'Invalid request parameters', details);
    this.name = 'ValidationError';
  }
}

function toDetails(issues: z.core.$ZodIssue[], source: 'body' | 'query'): Array<{ path: string; reason: string }> {
  return issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    return { path: field ? `${source}.${field}` : source, reason: issue.message };
  });
}

/** JSON body 校验中间件：成功后 c.req.valid('json') 得到 schema 输出类型 */
export function jsonBody<S extends z.ZodType>(schema: S) {
  return validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ValidationError(toDetails(parsed.error.issues, 'body'));
    return parsed.data;
  });
}

/**
 * Query 校验中间件：把 string[] 折叠成 string（取首项），
 * 让单值 zod schema 直接校验 query。
 */
export function query<S extends z.ZodType>(schema: S) {
  return validator('query', (value) => {
    const flattened: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, string | string[]>)) {
      flattened[k] = Array.isArray(v) ? (v[0] ?? '') : v;
    }
    const parsed = schema.safeParse(flattened);
    if (!parsed.success) throw new ValidationError(toDetails(parsed.error.issues, 'query'));
    return parsed.data;
  });
}
