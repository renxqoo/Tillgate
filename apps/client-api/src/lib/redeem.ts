import { sql, eq, and } from 'drizzle-orm';
import { redeemCodes, redeemBatches, users, transactions } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { Decimal } from '@ai-gateway/money';
import { sha256Hex } from './secrets.js';
import { unfreezeIfBadDebt } from '@ai-gateway/billing';

/** gateway 余额缓存键（与 billing.ts 一致） */
const BALANCE_CACHE_KEY = (userId: number) => `billing:balance:${userId}`;

/**
 * 充值码兑换核心逻辑（data-model §3.12 / requirements 4.8）。
 *
 * 原子性设计（防并发双花/重复兑换）：
 *   单事务内完成「标记码已用 + 加余额 + 写流水」，靠条件 UPDATE 影响行数判定：
 *     UPDATE redeem_codes
 *       SET status=1, used_by=?, used_at=now()
 *       WHERE code_hash=? AND status=0 AND (expires_at IS NULL OR expires_at > now())
 *   - 影响行数 = 1 → 首次兑换，继续加余额 + 写流水
 *   - 影响行数 = 0 → 已用/作废/过期/不存在，按状态返回具体错误码
 *
 *   余额变更走原子 UPDATE（balance.ts 的同口径），并发安全。
 *
 * 返回值约定（错误码对齐 api-contract §4.1）：
 *   - ok → { ok:true, amount, balanceAfter }
 *   - 不存在 → { ok:false, code:'invalid_code' }
 *   - 已使用 → { ok:false, code:'code_already_used' }
 *   - 已作废 → { ok:false, code:'code_revoked' }
 *   - 已过期 → { ok:false, code:'code_expired' }
 */

export interface RedeemResult {
  ok: boolean;
  amount?: string;
  balanceBefore?: string;
  balanceAfter?: string;
  code?: 'invalid_code' | 'code_already_used' | 'code_revoked' | 'code_expired';
}

export async function redeemCode(db: Db, userId: number, plaintextCode: string, redis?: Redis): Promise<RedeemResult> {
  const codeHash = sha256Hex(plaintextCode);

  // 单事务：原子标记 + 加余额 + 写流水
  return db.transaction(async (tx) => {
    // 1. 条件 UPDATE 标记码为已用（status=0 → 1，且未过期）
    const claimed = await tx
      .update(redeemCodes)
      .set({ status: 1, usedBy: userId, usedAt: new Date() })
      .where(
        and(
          eq(redeemCodes.codeHash, codeHash),
          eq(redeemCodes.status, 0),
          sql`${redeemCodes.expiresAt} is null or ${redeemCodes.expiresAt} > now()`,
        ),
      )
      .returning({ id: redeemCodes.id, batchId: redeemCodes.batchId });

    if (claimed.length === 0) {
      // 未命中：查码当前状态，返回精确错误码
      const row = await tx
        .select({ status: redeemCodes.status, expiresAt: redeemCodes.expiresAt })
        .from(redeemCodes)
        .where(eq(redeemCodes.codeHash, codeHash))
        .limit(1);
      if (row.length === 0) return { ok: false, code: 'invalid_code' as const };
      const s = row[0]!.status;
      if (s === 1) return { ok: false, code: 'code_already_used' as const };
      if (s === 2) return { ok: false, code: 'code_revoked' as const };
      // status=0 但未命中条件 UPDATE → 过期
      return { ok: false, code: 'code_expired' as const };
    }

    const code = claimed[0]!;
    // 2. 取面额（batch 缺失时抛错回滚，防 code 被消费但用户拿 0 元——R-1 资损修复）
    const batch = await tx
      .select({ amount: redeemBatches.amount })
      .from(redeemBatches)
      .where(eq(redeemBatches.id, code.batchId))
      .limit(1);
    if (batch.length === 0) {
      throw new Error(`batch_not_found: batchId=${code.batchId}（兑换码 ${code.id} 关联的批次不存在）`);
    }
    const amount = batch[0]!.amount;

    // 3. 原子加余额（RETURNING 拿前后值；amount 是元 string）
    const updated = await tx
      .update(users)
      .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ balance: users.balance });
    if (updated.length === 0) {
      // 用户不存在（理论上前置会话已校验，这里是防御）
      throw new Error('user_not_found');
    }
    const balanceAfter = updated[0]!.balance;
    const balanceBefore = new Decimal(balanceAfter).minus(new Decimal(amount)).toString();

    // 4. 写流水（type=redeem；幂等：ref_type='redeem_codes' 部分唯一索引 + ON CONFLICT）
    await tx.insert(transactions).values({
      userId,
      type: 'redeem',
      amount,
      balanceBefore,
      balanceAfter,
      refType: 'redeem_codes',
      refId: String(code.id),
      remark: `充值码兑换 +${amount}`,
    }).onConflictDoNothing({
      target: [transactions.refType, transactions.refId],
      where: sql`ref_type = 'redeem_codes'`,
    });

    return { ok: true, amount, balanceBefore, balanceAfter };
  }).then(async (r) => {
    // 5. 成功后解冻坏账冻结 + 失效 gateway 余额缓存（事务外，避免长事务）
    if (r.ok && r.amount && new Decimal(r.amount).gt(0)) {
      await unfreezeIfBadDebt(db, userId).catch(() => {});
      // 失效 gateway 余额缓存：充值后 gateway 必须重读 DB，否则读到旧缓存（含负数）→ 误判余额不足
      redis?.del(BALANCE_CACHE_KEY(userId)).catch(() => {});
    }
    return r;
  });
}
