/**
 * 请求校验组件：JSON body / query 的 zod 校验中间件。
 * 失败抛 http.validation_failed（context 平铺 path→reason——errors 包 ErrorContext
 * scalar-only 契约），由 errorHandling 统一渲染（status 由 category invalid_input 派生 400）。
 *
 * 依赖协议栈先装 bodyParser（createBodyParser 门面单次 memo 读取——jsonBody 与
 * handler 内再次 c.req.json() 共享同一次读取）；解析结果落在 c.state.validJson /
 * validQuery，经 jsonBodyOf<T>/queryOf<T> 类型化读取（替代旧 c.req.valid()）。
 */
import { isHttpError } from 'keala';
import type { z } from 'zod';
import type { Context, ContextWithBody, Middleware } from '../framework/keala';
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

/** 读请求体（经 bodyParser facade；畸形 JSON 翻 invalid_json，其余错误原样上抛） */
async function bodyJson(c: Context): Promise<unknown> {
  try {
    return await (c as ContextWithBody).req.json();
  } catch (error) {
    if (isHttpError(error) && error.status === 400) throw HttpErrors.business('invalid_json');
    throw error;
  }
}

/** JSON body 校验中间件：成功后 jsonBodyOf<输出类型>(c) 取得解析结果 */
export function jsonBody<S extends z.ZodType>(schema: S): Middleware {
  return async (c, next) => {
    const parsed = schema.safeParse(await bodyJson(c));
    if (!parsed.success) throw rejection(parsed.error.issues, 'body');
    c.state.validJson = parsed.data;
    await next();
  };
}

/**
 * Query 校验中间件：把 string[] 折叠成 string（取首项），
 * 让单值 zod schema 直接校验 query。
 */
export function query<S extends z.ZodType>(schema: S): Middleware {
  return async (c, next) => {
    const flattened: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.query)) {
      flattened[k] = Array.isArray(v) ? (v[0] ?? '') : v;
    }
    const parsed = schema.safeParse(flattened);
    if (!parsed.success) throw rejection(parsed.error.issues, 'query');
    c.state.validQuery = parsed.data;
    await next();
  };
}

/** jsonBody 落值的类型化读取（旧 c.req.valid('json') 的替代） */
export function jsonBodyOf<T>(c: Context): T {
  return c.state.validJson as T;
}

/** query 落值的类型化读取（旧 c.req.valid('query') 的替代） */
export function queryOf<T>(c: Context): T {
  return c.state.validQuery as T;
}
