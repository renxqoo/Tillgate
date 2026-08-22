/**
 * providers 供应商 postgres 适配器（v1 provider.repo 等价迁移）：
 * 管理面 CRUD + 统一列表。重名交给 PG 唯一索引（23505 由 application 翻译冲突）；
 * 删除 = 软退役（status=1），历史渠道引用不受影响。
 */
import { asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { DbLike } from '@tokenlens/db';
import { providers } from '@tokenlens/db';
import type { ProviderPatchInput } from '../../domain/provider/provider';
import type { ListQuery, ListResult } from '../../domain/list';
import type { ProviderRecord, ProviderStore, ProviderSortField } from '../../ports/provider-store';
import { escapeLikePattern } from './search';

const PROVIDER_COLUMNS = {
  id: providers.id,
  name: providers.name,
  protocol: providers.protocol,
  vendor: providers.vendor,
  baseUrl: providers.baseUrl,
  status: providers.status,
  createdAt: providers.createdAt,
} as const;

const PROVIDER_SORTS = {
  id: providers.id,
  name: providers.name,
  status: providers.status,
  createdAt: providers.createdAt,
} as const;

/** 排序白名单收敛 + id 决胜（分页无跳无重） */
function orderByOf(sortBy: ProviderSortField, order: 'asc' | 'desc') {
  const column = PROVIDER_SORTS[sortBy];
  return [order === 'asc' ? asc(column) : desc(column), desc(providers.id)];
}

export const postgresProviderStore: ProviderStore = {
  async insert(db: DbLike, input) {
    const [row] = await db
      .insert(providers)
      .values({
        name: input.name,
        protocol: input.protocol,
        vendor: input.vendor,
        baseUrl: input.baseUrl,
        status: input.status,
      })
      .returning(PROVIDER_COLUMNS);
    if (!row) throw new Error('provider.insert_failed');
    return row as ProviderRecord;
  },

  async findById(db: DbLike, providerId: number) {
    const [row] = await db
      .select(PROVIDER_COLUMNS)
      .from(providers)
      .where(eq(providers.id, providerId));
    return (row as ProviderRecord) ?? null;
  },

  async findByName(db: DbLike, name: string) {
    const [row] = await db.select(PROVIDER_COLUMNS).from(providers).where(eq(providers.name, name));
    return (row as ProviderRecord) ?? null;
  },

  async update(db: DbLike, input: { providerId: number; patch: ProviderPatchInput }) {
    const rows = await db
      .update(providers)
      .set(input.patch)
      .where(eq(providers.id, input.providerId))
      .returning(PROVIDER_COLUMNS);
    return (rows[0] as ProviderRecord) ?? null;
  },

  async retire(db: DbLike, input: { providerId: number }) {
    const rows = await db
      .update(providers)
      .set({ status: 1 })
      .where(eq(providers.id, input.providerId))
      .returning({ id: providers.id });
    return rows.length > 0;
  },

  async list(db: DbLike, query: ListQuery<ProviderSortField>): Promise<ListResult<ProviderRecord>> {
    const where = query.q
      ? or(
          ilike(providers.name, escapeLikePattern(query.q)),
          ilike(providers.baseUrl, escapeLikePattern(query.q)),
        )
      : undefined;
    const [rows, countRows] = await Promise.all([
      db
        .select(PROVIDER_COLUMNS)
        .from(providers)
        .where(where)
        .orderBy(...orderByOf(query.sortBy, query.order))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(providers)
        .where(where),
    ]);
    return { rows: rows as ProviderRecord[], total: countRows[0]?.count ?? 0 };
  },
};
