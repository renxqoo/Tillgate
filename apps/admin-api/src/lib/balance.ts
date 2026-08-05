import { sql, eq } from 'drizzle-orm';
import { users, transactions } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { Decimal } from '@ai-gateway/money';

/** gateway 余额缓存键（与 apps/gateway/src/lib/billing.ts 一致，跨服务 DEL 失效） */
const BALANCE_CACHE_KEY = (userId: number) => `billing:balance:${userId}`;

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
  | { ok: true; balanceBefore: string; balanceAfter: string }
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
  amount: string | number,
  opts: { checkSufficient?: boolean; redis?: Redis } = {},
): Promise<BalanceChangeResult> {
  // delta 用 string 透传给 DB（numeric 列原生 string，避免 JS number 浮点）
  const delta = typeof amount === 'number' ? String(amount) : amount;
  if (!/^-?\d+(\.\d+)?$/.test(delta)) return { ok: false, reason: 'not_found' };

  // 失效 gateway 余额缓存（充值/扣费后，gateway 的 Redis 缓存必须失效）。
  // 注：重构后 gateway 不再缓存余额（DB 行锁权威），此处 DEL 仅清理可能的残留/兼容旧实例。
  const invalidateCache = () => {
    opts.redis?.del(BALANCE_CACHE_KEY(userId)).catch(() => {});
  };

  // 扣减且要求不透支：用条件 UPDATE（WHERE balance + delta >= 0）
  if (delta.startsWith('-') && opts.checkSufficient) {
    const updated = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${delta}::numeric`, updatedAt: new Date() })
      .where(sql`${users.id} = ${userId} and ${users.balance} + ${delta}::numeric >= 0`)
      .returning({ balance: users.balance });
    if (updated.length === 0) {
      const exists = await db.select({ id: users.id }).from(users).where(sql`${users.id} = ${userId}`).limit(1);
      return { ok: false, reason: exists.length === 0 ? 'not_found' : 'insufficient' };
    }
    const after = updated[0]!.balance;
    invalidateCache();
    // balanceBefore = after - delta（用 Decimal 避免浮点）
    const before = new Decimal(after).minus(new Decimal(delta)).toString();
    return { ok: true, balanceBefore: before, balanceAfter: after };
  }

  // 普通变更（充值/赠送/调账，不检查透支）
  const updated = await db
    .update(users)
    .set({ balance: sql`${users.balance} + ${delta}::numeric`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ balance: users.balance });
  if (updated.length === 0) return { ok: false, reason: 'not_found' };
  const after = updated[0]!.balance;
  invalidateCache();
  const before = new Decimal(after).minus(new Decimal(delta)).toString();
  return { ok: true, balanceBefore: before, balanceAfter: after };
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
    amount: string; // 有符号（元，string）
    balanceBefore: string;
    balanceAfter: string;
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
 * 解冻账户：充值/调账后若 status=1 且 freezeReason='bad_debt' → 自动解冻。
 * requirements：充值后自动解冻并清空 freeze_reason（data-model §3.1）。
 * B-1 修复：只清坏账冻结（freeze_reason='bad_debt'），不动 manual_review 等人工冻结原因。
 */
export async function unfreezeIfBadDebt(db: Db, userId: number): Promise<void> {
  await db
    .update(users)
    .set({ freezeReason: null, updatedAt: new Date() })
    .where(sql`${users.id} = ${userId} and ${users.freezeReason} = 'bad_debt' and ${users.status} = 1`);
}
