/**
 * 列表查询的纯 query-string 半边；drizzle 耦合半边（searchCondition/resolveOrderBy/
 * buildList/countAll 及白名单拒绝语义）归列表端点消费者（apps/client/src/server/list-query.ts）。
 */
import * as z from 'zod';
import { paginationQuerySchema } from './page';

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

export const sortQuerySchema = z.object({
  sort_by: z.string().trim().min(1).max(64).optional(),
  order: sortOrderSchema,
});

/** 搜索词 schema：trim 后 1~100 字符（缺失/空白 → undefined，不拼条件） */
export const searchQuerySchema = z.preprocess((v) => {
  if (typeof v !== 'string') return;
  const t = v.trim();
  return t === '' ? undefined : t;
}, z.string().min(1).max(100).optional());

/** LIKE 模式中的 % _ \ 按字面匹配（PG 默认转义符是反斜杠） */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 列表查询组合 schema：分页 + 搜索 + 排序。
 * 各路由以此为基底 extend 差异字段（如 status/from/to），替代逐字重复的
 * `paginationQuerySchema.extend({ q: searchQuerySchema, ...sortQuerySchema.shape })`。
 */
export const listQuerySchema = paginationQuerySchema.extend({
  q: searchQuerySchema,
  ...sortQuerySchema.shape,
});
