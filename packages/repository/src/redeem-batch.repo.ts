/**
 * redeem_batches/redeem_codes 仓储（管理面批次生成与码管理）。
 * 明文码只在生成时返回一次；库内唯一落 SHA-256（code_hash 唯一索引）。
 * 码状态：0 未用 / 1 已用 / 2 作废。
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { redeemBatches, redeemCodes } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

export interface RedeemBatchRow {
  id: number;
  name: string;
  remark: string | null;
  amount: string;
  total: number;
  usedCount: number;
  createdBy: number;
  createdAt: Date;
}

export interface RedeemCodeRow {
  id: number;
  codeMasked: string;
  status: number;
  usedBy: number | null;
  usedAt: Date | null;
  expiresAt: Date | null;
}

/** 兑换批次仓储（无状态；批次+码同事务生成——RepoContext.db 须为事务句柄） */
export class RedeemBatchRepository {
  /** 建批次 + 批量落码（单事务：码部分失败则批次整体回滚） */
  async insertBatchWithCodes(
    c: RepoContext,
    input: {
      name: string;
      remark: string | null;
      amount: string;
      total: number;
      createdBy: number;
      codes: Array<{ codeHash: string; expiresAt: Date | null }>;
    },
  ): Promise<{ batchId: number }> {
    const [batch] = await c.db
      .insert(redeemBatches)
      .values({
        name: input.name,
        remark: input.remark,
        amount: input.amount,
        total: input.total,
        usedCount: 0,
        createdBy: input.createdBy,
      })
      .returning({ id: redeemBatches.id });
    if (!batch) throw new Error('redeem_batch.insert_failed');
    await c.db.insert(redeemCodes).values(
      input.codes.map((code) => ({
        batchId: batch.id,
        codeHash: code.codeHash,
        expiresAt: code.expiresAt,
      })),
    );
    return { batchId: batch.id };
  }

  async findBatch(c: RepoContext, batchId: number): Promise<RedeemBatchRow | null> {
    const [row] = await c.db
      .select({
        id: redeemBatches.id,
        name: redeemBatches.name,
        remark: redeemBatches.remark,
        amount: redeemBatches.amount,
        total: redeemBatches.total,
        usedCount: redeemBatches.usedCount,
        createdBy: redeemBatches.createdBy,
        createdAt: redeemBatches.createdAt,
      })
      .from(redeemBatches)
      .where(eq(redeemBatches.id, batchId));
    return (row as RedeemBatchRow) ?? null;
  }

  /** 批次列表：q 命中 name/remark */
  async listBatches(
    c: RepoContext,
    input: { q?: string; sortBy: 'id' | 'name' | 'amount' | 'createdAt'; order: 'asc' | 'desc'; limit: number; offset: number },
  ): Promise<{ rows: RedeemBatchRow[]; total: number }> {
    const where = input.q
      ? or(
          ilike(redeemBatches.name, escapeLikePattern(input.q)),
          ilike(redeemBatches.remark, escapeLikePattern(input.q)),
        )
      : undefined;
    const sorts = {
      id: redeemBatches.id,
      name: redeemBatches.name,
      amount: redeemBatches.amount,
      createdAt: redeemBatches.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(redeemBatches.id)];
    const selection = {
      id: redeemBatches.id,
      name: redeemBatches.name,
      remark: redeemBatches.remark,
      amount: redeemBatches.amount,
      total: redeemBatches.total,
      usedCount: redeemBatches.usedCount,
      createdBy: redeemBatches.createdBy,
      createdAt: redeemBatches.createdAt,
    };
    const [rows, countRows] = await Promise.all([
      c.db.select(selection).from(redeemBatches).where(where).orderBy(...orderBy).limit(input.limit).offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(redeemBatches).where(where),
    ]);
    return { rows: rows as RedeemBatchRow[], total: countRows[0]?.count ?? 0 };
  }

  /** 批次内码列表（哈希脱敏 left 8；码无文本列——无 q 搜索） */
  async listCodes(
    c: RepoContext,
    input: { batchId: number; status?: number; sortBy: 'id' | 'usedAt'; order: 'asc' | 'desc'; limit: number; offset: number },
  ): Promise<{ rows: RedeemCodeRow[]; total: number }> {
    const conditions = [eq(redeemCodes.batchId, input.batchId)];
    if (input.status !== undefined) conditions.push(eq(redeemCodes.status, input.status));
    const where = and(...conditions);
    const sorts = { id: redeemCodes.id, usedAt: redeemCodes.usedAt } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(redeemCodes.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: redeemCodes.id,
          codeMasked: sql<string>`left(${redeemCodes.codeHash}, 8) || '...'`,
          status: redeemCodes.status,
          usedBy: redeemCodes.usedBy,
          usedAt: redeemCodes.usedAt,
          expiresAt: redeemCodes.expiresAt,
        })
        .from(redeemCodes)
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(redeemCodes).where(where),
    ]);
    return { rows: rows as RedeemCodeRow[], total: countRows[0]?.count ?? 0 };
  }

  /** 作废（CAS status=0→2）：已用/已作废/不存在统一 0 行——上层翻 404 */
  async revokeCode(c: RepoContext, input: { codeId: number }): Promise<boolean> {
    const rows = await c.db
      .update(redeemCodes)
      .set({ status: 2 })
      .where(and(eq(redeemCodes.id, input.codeId), eq(redeemCodes.status, 0)))
      .returning({ id: redeemCodes.id });
    return rows.length > 0;
  }
}
