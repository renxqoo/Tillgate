/**
 * providers 供应商 postgres 适配器（逻辑删除回收站）：
 * 管理面 CRUD + 统一列表。重名交给 PG 部分唯一索引（23505 由 application 翻译冲突
 * ——已删除行不占名）；禁用 = status=1；删除 = 逻辑删除（status=1 + deleted_at，
 * 历史渠道 FK 引用不受影响），已删除行对管理面读/改不可见。
 */
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { providers } from '@tillgate/db';
import type { ProviderPatchInput } from '../../domain/provider/provider';
import type { ListResult } from '../../domain/list';
import type {
  ProviderRecord,
  ProviderStore,
  ProviderSortField,
  ProviderListQuery,
} from '../../ports/provider-store';
import { escapeLikePattern } from './search';

const PROVIDER_COLUMNS = {
  id: providers.id,
  name: providers.name,
  protocol: providers.protocol,
  vendor: providers.vendor,
  baseUrl: providers.baseUrl,
  status: providers.status,
  deletedAt: providers.deletedAt,
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
      .where(and(eq(providers.id, providerId), isNull(providers.deletedAt)));
    return (row as ProviderRecord) ?? null;
  },

  async findByName(db: DbLike, name: string) {
    const [row] = await db
      .select(PROVIDER_COLUMNS)
      .from(providers)
      .where(and(eq(providers.name, name), isNull(providers.deletedAt)));
    return (row as ProviderRecord) ?? null;
  },

  async update(db: DbLike, input: { providerId: number; patch: ProviderPatchInput }) {
    const rows = await db
      .update(providers)
      .set(input.patch)
      // 已删除记录不可编辑（回收站行只读——恢复走 restore）
      .where(and(eq(providers.id, input.providerId), isNull(providers.deletedAt)))
      .returning(PROVIDER_COLUMNS);
    return (rows[0] as ProviderRecord) ?? null;
  },

  async retire(db: DbLike, input: { providerId: number }) {
    const rows = await db
      .update(providers)
      .set({ status: 1 })
      .where(and(eq(providers.id, input.providerId), isNull(providers.deletedAt)))
      .returning({ id: providers.id });
    return rows.length > 0;
  },

  async softDelete(db: DbLike, input: { providerId: number }) {
    const rows = await db
      .update(providers)
      // status 同步压 1：服务面 status=0 语义不再出现在已删除行
      .set({ status: 1, deletedAt: new Date() })
      .where(and(eq(providers.id, input.providerId), isNull(providers.deletedAt)))
      .returning({ id: providers.id });
    return rows.length > 0;
  },

  async restore(db: DbLike, input: { providerId: number }) {
    const rows = await db
      .update(providers)
      // 回禁用态：不直接启用——复核后由管理员显式启用
      .set({ deletedAt: null, status: 1 })
      .where(and(eq(providers.id, input.providerId), isNotNull(providers.deletedAt)))
      .returning({ id: providers.id });
    return rows.length > 0;
  },

  async list(db: DbLike, query: ProviderListQuery): Promise<ListResult<ProviderRecord>> {
    // 视图：active（缺省）= 在册（不含已删除）；deleted = 回收站（仅已删除）
    const viewWhere =
      query.view === 'deleted' ? isNotNull(providers.deletedAt) : isNull(providers.deletedAt);
    const where = query.q
      ? and(
          viewWhere,
          or(
            ilike(providers.name, escapeLikePattern(query.q)),
            ilike(providers.baseUrl, escapeLikePattern(query.q)),
          ),
        )
      : viewWhere;
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
