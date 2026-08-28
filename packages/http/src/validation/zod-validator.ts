/**
 * 请求校验组件：JSON body / query 的 zod 校验中间件。
 * 失败抛 http.validation_failed（context 平铺 path→reason——errors 包 ErrorContext
 * scalar-only 契约），由 errorHandler 统一渲染（status 由 category invalid_input 派生 400）。
 *
 * 不用 @hono/zod-validator：zod v4 classic API 下联合类型会导致 TS 重载报错。
 */
import { validator } from 'hono/validator';
import type { z } from 'zod';
import { HttpErrors } from '../errors/catalog';

/** zod issues → 平铺 context：`body.name` / `query.page` 形态的 path 键（同 path 保留首个 issue） */
function rejection(issues: z.core.$ZodIssue[], source: 'body' | 'query') {
  const context: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path.map(String).join('.');
    const key = field === '' ? source : `${source}.${field}`;
    if (context[key] === undefined) context[key] = issue.message;
  }
  return HttpErrors.business('validation_failed', context);
}

/** JSON body 校验中间件：成功后 c.req.valid('json') 得到 schema 输出类型 */
export function jsonBody<S extends z.ZodType>(schema: S) {
  return validator('json', (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw rejection(parsed.error.issues, 'body');
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
    if (!parsed.success) throw rejection(parsed.error.issues, 'query');
    return parsed.data;
  });
}
