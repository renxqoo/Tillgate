/**
 * providers 供应商仓储（管理面 CRUD + 统一列表）。
 * 语义边界：重名交给 PG 唯一索引（23505 由 app 层翻译 409）；
 * 删除 = 软退役（status=1），历史渠道引用不受影响。
 */
import { asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { providers } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

export interface ProviderRow {
  id: number;
  name: string;
  protocol: string;
  baseUrl: string;
  status: number;
  createdAt: Date;
}

export interface ProviderListInput {
  q?: string;
  sortBy: 'id' | 'name' | 'status' | 'createdAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const PROVIDER_COLUMNS = {
  id: providers.id,
  name: providers.name,
  protocol: providers.protocol,
  baseUrl: providers.baseUrl,
  status: providers.status,
  createdAt: providers.createdAt,
};

const PROVIDER_SORTS = {
  id: providers.id,
  name: providers.name,
  status: providers.status,
  createdAt: providers.createdAt,
} as const;

/** 供应商仓储（无状态；方法统一接收 RepoContext） */
export class ProviderRepository {
  async insert(
    c: RepoContext,
    input: { name: string; protocol: string; baseUrl: string; status?: number },
  ): Promise<ProviderRow> {
    const [row] = await c.db
      .insert(providers)
      .values({
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        status: input.status ?? 0,
      })
      .returning(PROVIDER_COLUMNS);
    if (!row) throw new Error('provider.insert_failed');
    return row as ProviderRow;
  }

  async findById(c: RepoContext, providerId: number): Promise<ProviderRow | null> {
    const [row] = await c.db
      .select(PROVIDER_COLUMNS)
      .from(providers)
      .where(eq(providers.id, providerId));
    return (row as ProviderRow) ?? null;
  }

  /** 按名精确查（目录导入 find-or-create / 渠道导入供应商解析用） */
  async findByName(c: RepoContext, name: string): Promise<ProviderRow | null> {
    const [row] = await c.db
      .select(PROVIDER_COLUMNS)
      .from(providers)
      .where(eq(providers.name, name));
    return (row as ProviderRow) ?? null;
  }

  /** 部分更新（仅白名单字段；0 行 = 不存在） */
  async update(
    c: RepoContext,
    input: {
      providerId: number;
      patch: { name?: string; protocol?: string; baseUrl?: string; status?: number };
    },
  ): Promise<ProviderRow | null> {
    const rows = await c.db
      .update(providers)
      .set(input.patch)
      .where(eq(providers.id, input.providerId))
      .returning(PROVIDER_COLUMNS);
    return (rows[0] as ProviderRow) ?? null;
  }

  /** 软退役：status=1（行必须存在——0 行 = 不存在） */
  async retire(c: RepoContext, input: { providerId: number }): Promise<boolean> {
    const rows = await c.db
      .update(providers)
      .set({ status: 1 })
      .where(eq(providers.id, input.providerId))
      .returning({ id: providers.id });
    return rows.length > 0;
  }

  /** 统一列表：q 命中 name/baseUrl（字面匹配）；排序由白名单字段 + id 决胜（分页无跳无重） */
  async list(c: RepoContext, input: ProviderListInput): Promise<{ rows: ProviderRow[]; total: number }> {
    const where = input.q
      ? or(ilike(providers.name, escapeLikePattern(input.q)), ilike(providers.baseUrl, escapeLikePattern(input.q)))
      : undefined;
    const column = PROVIDER_SORTS[input.sortBy];
    const orderBy = [
      input.order === 'asc' ? asc(column) : desc(column),
      desc(providers.id),
    ];
    const [rows, countRows] = await Promise.all([
      c.db.select(PROVIDER_COLUMNS).from(providers).where(where).orderBy(...orderBy).limit(input.limit).offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(providers).where(where),
    ]);
    return { rows: rows as ProviderRow[], total: countRows[0]?.count ?? 0 };
  }
}
