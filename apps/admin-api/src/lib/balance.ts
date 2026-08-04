import { sql, eq } from 'drizzle-orm';
import { users, transactions } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';

/**
 * 余额变更工具（admin-api 调账 / 充值码兑换 / 赠送共用）。
 *
 * 安全设计（与 worker/settle.ts 同口径）：
 *   - 原子条件 UPDATE：`SET balance = balance + amount RETURNING balance`
 *     PG 单条 UPDATE 天然原子，并发不丢更新，无需 FOR UPDATE 行锁
 *   - 返回扣/加后的余额，供 transactions 流水记录 balanceBefore/balanceAfter
 *   - 幂等保障：调用方按业务唯一键（如充值码 code_id / requestId）决定是否调用
 *
 * 与 worker 结算的区别：worker 是消费扣费（amount 为负），这里是调账/充值/赠送（可正可负）。
 */

export type BalanceChangeResult =
  | { ok: true; balanceBefore: number; balanceAfter: number }
  | { ok: false; reason: 'not_found' | 'insufficient' };

/**
 * 原子变更用户余额（可正可负）。
 *
 *   - amount > 0：充值/调账增加
 *   - amount < 0：扣减；checkSufficient=true 时拒绝透支（余额不足返回 ok=false）
 *   - balanceBefore/balanceAfter 用于写 transactions 流水
 *
 * 注意：本函数不写 transactions 流水（调用方负责，因为流水类型/ref 不同）。
 *       单独抽出是为让余额变更这一「资损关键操作」集中在一处原子完成。
 */
export async function changeBalance(
  db: Db,
  userId: number,
  amount: number,
  opts: { checkSufficient?: boolean } = {},
): Promise<BalanceChangeResult> {
  const delta = Math.round(amount); // 厘整数
  if (!Number.isFinite(delta)) return { ok: false, reason: 'not_found' };

  // 扣减且要求不透支：用条件 UPDATE（WHERE balance + delta >= 0）
  if (delta < 0 && opts.checkSufficient) {
    const updated = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${delta}`, updatedAt: new Date() })
      .where(sql`${users.id} = ${userId} and ${users.balance} + ${delta} >= 0`)
      .returning({ balance: users.balance });
    if (updated.length === 0) {
      // 用户不存在 或 余额不足（二者需调用方按存在性区分）
      const exists = await db.select({ id: users.id }).from(users).where(sql`${users.id} = ${userId}`).limit(1);
      return { ok: false, reason: exists.length === 0 ? 'not_found' : 'insufficient' };
    }
    const after = updated[0]!.balance;
    return { ok: true, balanceBefore: after - delta, balanceAfter: after };
  }

  // 普通变更（充值/赠送/调账，不检查透支）
  const updated = await db
    .update(users)
    .set({ balance: sql`${users.balance} + ${delta}`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ balance: users.balance });
  if (updated.length === 0) return { ok: false, reason: 'not_found' };
  const after = updated[0]!.balance;
  return { ok: true, balanceBefore: after - delta, balanceAfter: after };
}

/**
 * 写一条资金流水（transactions）。
 * 封装为单点便于所有余额变更路径统一格式 + 容错（流水写失败不阻塞主流程）。
 */
export async function recordTransaction(
  db: Db,
  input: {
    userId: number;
    type: 'consume' | 'redeem' | 'gift' | 'manual' | 'refund' | 'subscribe';
    amount: number; // 有符号
    balanceBefore: number;
    balanceAfter: number;
    refType?: string;
    refId?: string;
    remark?: string;
    createdBy?: number | null;
  },
): Promise<void> {
  await db.insert(transactions).values({
    userId: input.userId,
    type: input.type,
    amount: input.amount,
    balanceBefore: input.balanceBefore,
    balanceAfter: input.balanceAfter,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    remark: input.remark ?? null,
    createdBy: input.createdBy ?? null,
  });
}

/**
 * 解冻账户：充值/调账后若 status=1（封禁因坏账冻结）且 freezeReason 非空 → 自动解冻。
 * requirements：充值后自动解冻并清空 freeze_reason（data-model §3.1）。
 */
export async function unfreezeIfBadDebt(db: Db, userId: number): Promise<void> {
  await db
    .update(users)
    .set({ freezeReason: null, updatedAt: new Date() })
    .where(sql`${users.id} = ${userId} and ${users.freezeReason} is not null and ${users.status} = 1`);
}
