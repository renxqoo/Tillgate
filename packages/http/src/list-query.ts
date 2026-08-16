import { z } from 'zod';
import { and, asc, desc, ilike, or, sql, type Column, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '@ai-gateway/db';
import { HttpError } from './errors.js';
import { limitOffset, paginationQuerySchema, parsePagination, type PaginationParams } from './pagination.js';/**
 * 列表查询统一组件（api-contract §4）：
 *   - 排序：?sort_by=<白名单字段>&order=asc|desc，默认 fallback 列 desc（通常为 created_at desc）
 *   - 搜索：?q=<关键词>，对给定文本列做 ilike %q%（搜索词按字面匹配，% _ \ 转义）
 *
 * 白名单外的 sort_by 一律 400 INVALID_SORT_FIELD（不允许静默回退——静默会掩盖前端拼写错误）。
 */

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

export const sortQuerySchema = z.object({
  sort_by: z.string().trim().min(1).max(64).optional(),
  order: sortOrderSchema,
});

/** 搜索词 schema：trim 后 1~100 字符（缺失/空白 → undefined，不拼条件） */
export const searchQuerySchema = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  },
  z.string().min(1).max(100).optional(),
);

/** LIKE 模式中的 % _ \ 按字面匹配（PG 默认转义符是反斜杠） */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 可搜索目标：列，或表达式（uuid 等非文本列需显式 ::text 转型） */
export type Searchable = Column | SQL;

/**
 * 组装搜索条件：q 命中任一目标即返回该行（单个直接 ilike，多个 OR）。
 * q 为空或目标清单为空 → undefined（调用方用 and(...) 自然跳过）。
 */
export function searchCondition(q: string | undefined, targets: Searchable[]): SQL | undefined {
  const term = q?.trim();
  if (!term || targets.length === 0) return undefined;
  const pattern = `%${escapeLike(term)}%`;
  const conditions = targets.map((target) =>
    isColumn(target) ? ilike(target, pattern) : sql`${target} ilike ${pattern}`,
  );
  return conditions.length === 1 ? conditions[0] : or(...conditions);
}

function isColumn(target: Searchable): target is Column {
  return typeof (target as Column).dataType === 'string';
}

export interface SortInput {
  sort_by?: string;
  order?: 'asc' | 'desc';
}

/**
 * 解析排序：白名单映射 + fallback + **必选**唯一 tiebreaker（BUG-D，new-api #6241 同类）。
 * Postgres 对 ORDER BY 非唯一键的并列行顺序未定义（受物理布局/并发更新影响），
 * LIMIT/OFFSET 翻页可重复/漏行——排序输出必须是全序：主键 + 唯一列（建议 id）
 * 两段。tiebreaker 从「可选」改为「必选」是结构性修复：漏传在编译期即报错。
 * 返回值直接喂给 drizzle 的 .orderBy(...orderBy)。
 */
export function resolveOrderBy<S extends Record<string, Column | SQL>>(
  input: SortInput,
  allowed: S,
  fallback: keyof S & string,
  tiebreaker: Column,
): SQL[] {
  const field = input.sort_by ?? fallback;
  // hasOwn：allowed[field] 会命中 Object 原型成员（constructor 等 truthy），
  // 穿透白名单后 drizzle 把构造函数当列 → 运行期 500（应为 400）
  if (!Object.hasOwn(allowed, field)) {
    throw new HttpError(
      'INVALID_SORT_FIELD',
      `不支持的排序字段：${field}`,
      { allowed: Object.keys(allowed) },
    );
  }
  const column = allowed[field];
  if (!column) {
    throw new HttpError(
      'INVALID_SORT_FIELD',
      `不支持的排序字段：${field}`,
      { allowed: Object.keys(allowed) },
    );
  }
  const primary = (input.order ?? 'desc') === 'asc' ? asc(column) : desc(column);
  return [primary, desc(tiebreaker)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 列表端点组装（listQuerySchema + buildList + countAll）
//
// 各列表路由的同构样板（分页解析 → 搜索/过滤条件 → 排序白名单 → 列表+计数两查）
// 收口到这里；路由只保留真正的差异：select 列/join、搜索目标、排序白名单、
// 软删过滤与 query 派生筛选（一律通过参数表达，不内联特判）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 列表查询组合 schema：分页 + 搜索 + 排序。
 * 各路由以此为基底 extend 差异字段（如 status/from/to），替代逐字重复的
 * `paginationQuerySchema.extend({ q: searchQuerySchema, ...sortQuerySchema.shape })`。
 */
export const listQuerySchema = paginationQuerySchema.extend({
  q: searchQuerySchema,
  ...sortQuerySchema.shape,
});

/** buildList 的输入：listQuerySchema（或其 extend）解析后的 query 对象 */
export interface ListQueryInput extends SortInput {
  page?: number;
  page_size?: number;
  q?: string;
}

/** 排序规格：白名单 + 默认字段 + 必选唯一 tiebreaker（三者必须一起给） */
export interface ListSortSpec<S extends Record<string, Column | SQL>> {
  /** sort_by 白名单（键 = API 字段名，值 = 列/表达式） */
  by: S;
  /** 未传 sort_by 时的默认排序字段 */
  fallback: keyof S & string;
  /** 唯一 tiebreaker：保证排序全序，翻页不重不漏 */
  tiebreaker: Column;
}

export interface BuildListOptions<S extends Record<string, Column | SQL>> {
  /** q 的搜索目标列；省略 = 该列表不支持 q（不拼搜索条件） */
  search?: Searchable[];
  /** 搜索之外的附加条件（软删过滤、会话/权限限定、query 派生筛选）；undefined 项自动忽略 */
  conditions?: (SQL | undefined)[];
  /** 排序规格；省略 = 该列表无排序参数（orderBy 为空） */
  sort?: ListSortSpec<S>;
}

/** buildList 的产物：直接喂给 drizzle 链与 paginateQuery */
export interface ListParts {
  page: PaginationParams;
  limit: number;
  offset: number;
  where: SQL | undefined;
  orderBy: SQL[];
}

/**
 * 一次性完成列表端点的同构计算：
 *   parsePagination → limitOffset → searchCondition + 附加条件 → and(...) → resolveOrderBy
 * 条件拼接语义与各路由原实现逐字等价：无条件 → undefined；有条件（含单个）→ and(...)。
 */
export function buildList<S extends Record<string, Column | SQL>>(
  input: ListQueryInput,
  options: BuildListOptions<S> = {},
): ListParts {
  const page = parsePagination(input);
  const { limit, offset } = limitOffset(page);
  const conds = (options.conditions ?? []).filter((c): c is SQL => c !== undefined);
  const search = options.search ? searchCondition(input.q, options.search) : undefined;
  if (search) conds.push(search);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const orderBy = options.sort
    ? resolveOrderBy(input, options.sort.by, options.sort.fallback, options.sort.tiebreaker)
    : [];
  return { page, limit, offset, where, orderBy };
}

/** 计数 join 描述：表 + ON 条件，必须与主查询的 innerJoin 完全一致 */
export interface CountJoin {
  table: PgTable;
  on: SQL;
}

/**
 * 标准计数查询：`select count(*)::int from <table> [joins] [where]`。
 * 搜索目标在关联表（如 users.email / channels.name）时，where 会引用 join 表列——
 * 计数必须与主查询做同样的 join，否则 PG 42P01（missing FROM-clause）→ 500。
 * joins 参数就是为此存在：所有列表路由统一走本入口，不再手写 count
 * （手写/组件两套写法并存正是 keys/channel-funds/subscriptions 三处 500 的根因）。
 */
export function countAll(db: Db, table: PgTable, where?: SQL, joins: CountJoin[] = []) {
  let query = db.select({ count: sql<number>`count(*)::int` }).from(table).$dynamic();
  for (const join of joins) {
    query = query.innerJoin(join.table, join.on);
  }
  return query.where(where);
}
