import { generateRedeemCode, recordAudit, sha256Hex } from '@ai-gateway/http';
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
