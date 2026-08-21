/**
 * 兑换码仓储：核销是单语句 CAS（status=0→1 且未过期，同拍写 usedBy/usedAt）——
 * 兑换的资金语义（wallet credit）由用例层在同事务内追加，哈希对账不经过本仓储。
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { redeemBatches, redeemCodes } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface RedeemClaimRow {
  codeId: number;
  batchId: number;
  /** 批次面额（同事务读——claim 成功即锁定该批次的金额真相） */
  amount: string;
}

/** 兑换码仓储（无状态；方法统一接收 RepoContext） */
export class RedeemCodeRepository {
  /** 按哈希查码（错误语义区分用：无效码 vs 已用码） */
  async findByCodeHash(
    c: RepoContext,
    codeHash: string,
  ): Promise<{ id: number; batchId: number; status: number; expiresAt: Date | null } | null> {
    const [row] = await c.db
      .select({
        id: redeemCodes.id,
        batchId: redeemCodes.batchId,
        status: redeemCodes.status,
        expiresAt: redeemCodes.expiresAt,
      })
      .from(redeemCodes)
      .where(eq(redeemCodes.codeHash, codeHash));
    return row ?? null;
  }

  /**
   * 核销抢占（CAS）：WHERE status=0 AND (expiresAt IS NULL OR expiresAt > now)。
   * 并发两方同码只有一个 RETURNING 行；赢家在同一事务里读批次面额入账。
   */
  async claim(
    c: RepoContext,
    input: { codeHash: string; userId: number; now: Date },
  ): Promise<RedeemClaimRow | null> {
    const rows = await tx(c)
      .update(redeemCodes)
      .set({ status: 1, usedBy: input.userId, usedAt: input.now })
      .where(
        sql`${redeemCodes.codeHash} = ${input.codeHash} and ${redeemCodes.status} = 0
            and (${redeemCodes.expiresAt} is null or ${redeemCodes.expiresAt} > ${input.now})`,
      )
      .returning({ id: redeemCodes.id, batchId: redeemCodes.batchId });
    const claimed = rows[0];
    if (!claimed) return null;
    const [batch] = await c.db
      .select({ amount: redeemBatches.amount })
      .from(redeemBatches)
      .where(eq(redeemBatches.id, claimed.batchId));
    return { codeId: claimed.id, batchId: claimed.batchId, amount: batch?.amount ?? '0' };
  }

  /** 用户已兑换记录（usedBy 硬隔离；面额随批次名带出） */
  async listRedeemedByUser(
    c: RepoContext,
    input: { userId: number; limit: number; offset: number },
  ): Promise<Array<{ codeId: number; batchName: string; amount: string; usedAt: Date | null }>> {
    return c.db
      .select({
        codeId: redeemCodes.id,
        batchName: redeemBatches.name,
        amount: redeemBatches.amount,
        usedAt: redeemCodes.usedAt,
      })
      .from(redeemCodes)
      .innerJoin(redeemBatches, eq(redeemCodes.batchId, redeemBatches.id))
      .where(and(eq(redeemCodes.usedBy, input.userId), eq(redeemCodes.status, 1)))
      .orderBy(desc(redeemCodes.usedAt))
      .limit(input.limit)
      .offset(input.offset);
  }
}
