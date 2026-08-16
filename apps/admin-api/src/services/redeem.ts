import { buildList, countAll, generateRedeemCode, HttpError, listQuerySchema, paginateQuery, paginationQuerySchema, recordAudit, sha256Hex, sortQuerySchema } from '@ai-gateway/http';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { redeemBatches, redeemCodes } from '@ai-gateway/db/schema';
import type { AdminServices } from './index.js';

/**
 * 充值码服务（api-contract §4.7 / requirements 4.8）。
 *
 * 安全设计（data-model §3.12）：
 *   - 明文只在创建时下发一次，落库的是 SHA-256 哈希（code_hash 唯一索引）
 *   - 面额创建后不可修改（改价需新建批次）
 *   - 建批次 + 批量插码在同一事务提交
 */

export interface RedeemBatchCreate {
  name: string;
  remark?: string;
  /** 面额（元，正小数） */
  amount: number;
  /** 生成数量 1~10000 */
  count: number;
  /** 过期时间 */
  expiresAt?: Date;
}

export interface RedeemBatchResult {
  batch: { id: number; name: string; amount: string; total: number };
  codes: string[];
}

export async function createRedeemBatch(
  s: AdminServices,
  input: RedeemBatchCreate,
  adminId: number,
): Promise<RedeemBatchResult> {
  const result = await s.db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(redeemBatches)
      .values({
        name: input.name,
        remark: input.remark ?? null,
        amount: String(input.amount),
        total: input.count,
        usedCount: 0,
        createdBy: adminId,
      })
      .returning();

    const codes: string[] = [];
    const rows: Array<{ batchId: number; codeHash: string; expiresAt: Date | null }> = [];
    for (let i = 0; i < input.count; i++) {
      const plaintext = generateRedeemCode();
      codes.push(plaintext);
      rows.push({ batchId: batch!.id, codeHash: sha256Hex(plaintext), expiresAt: input.expiresAt ?? null });
    }
    await tx.insert(redeemCodes).values(rows);
    return { batch: batch!, codes };
  });

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'redeem_batch.create',
    targetType: 'redeem_batch',
    targetId: result.batch.id,
    detail: { name: input.name, amount: input.amount, count: input.count },
  });

  return {
    batch: {
      id: result.batch.id,
      name: result.batch.name,
      amount: result.batch.amount,
      total: result.batch.total,
    },
    codes: result.codes,
  };
}

/** 作废单张码（仅未使用的可作废：status 0→2） */
export async function revokeRedeemCode(s: AdminServices, codeId: number, adminId: number): Promise<void> {
  const result = await s.db
    .update(redeemCodes)
    .set({ status: 2 })
    .where(and(eq(redeemCodes.id, codeId), eq(redeemCodes.status, 0)))
    .returning({ id: redeemCodes.id });
  if (result.length === 0) {
    throw new HttpError('REDEEM_CODE_NOT_FOUND', '码不存在或已使用/已作废');
  }
  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'redeem_code.revoke',
    targetType: 'redeem_code',
    targetId: codeId,
  });
}

export async function listRedeemBatches(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [redeemBatches.name, redeemBatches.remark],
    sort: {
      by: { id: redeemBatches.id, name: redeemBatches.name, amount: redeemBatches.amount, createdAt: redeemBatches.createdAt },
      fallback: 'createdAt',
      tiebreaker: redeemBatches.id,
    },
  });
  return paginateQuery(
    page,
    s.db
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
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, redeemBatches, where),
  );
}

export async function getRedeemBatch(s: AdminServices, id: number) {
  const rows = await s.db.select().from(redeemBatches).where(eq(redeemBatches.id, id)).limit(1);
  if (rows.length === 0) throw new HttpError('REDEEM_BATCH_NOT_FOUND', '批次不存在');
  return rows[0];
}

export async function listRedeemBatchCodes(s: AdminServices, id: number, q: z.infer<typeof batchCodesQuerySchema>) {
  // 兑换码只有哈希无文本列，不提供 q；默认 id desc（新生成在前）
  const { page, limit, offset, where, orderBy } = buildList(q, {
    conditions: [
      eq(redeemCodes.batchId, id),
      q.status !== undefined ? eq(redeemCodes.status, q.status) : undefined,
    ],
    sort: { by: { id: redeemCodes.id, usedAt: redeemCodes.usedAt }, fallback: 'id', tiebreaker: redeemCodes.id },
  });
  return paginateQuery(
    page,
    s.db
      .select({
        id: redeemCodes.id,
        // 脱敏：只显示哈希前 8 位 + ...（明文永不回显）
        codeMasked: sql<string>`left(${redeemCodes.codeHash}, 8) || '...'`,
        status: redeemCodes.status,
        usedBy: redeemCodes.usedBy,
        usedAt: redeemCodes.usedAt,
        expiresAt: redeemCodes.expiresAt,
      })
      .from(redeemCodes)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, redeemCodes, where),
  );
}

export const batchCodesQuerySchema = paginationQuerySchema.extend({
  ...sortQuerySchema.shape,
  status: z.coerce.number().int().min(0).max(2).optional(),
});
