/** 腿写入：记账原子单元——更新账户余额 + 落腿（链式恒等由调用方传 before/after，DB check 兜底） */
import { eq } from 'drizzle-orm';
import { Decimal, toStorage } from './money';
import { walletAccounts, walletLegs } from './schema';
import type { Tx } from './internal';

/** 在锁定账户上落一条腿并更新余额；返回余额快照（after） */
export async function applyLeg(
  tx: Tx,
  transactionId: number,
  accountId: string,
  currency: string,
  amount: Decimal,
  balanceBefore: string,
): Promise<string> {
  const balanceAfter = new Decimal(balanceBefore).plus(amount);
  await tx.insert(walletLegs).values({
    transactionId,
    accountId,
    currency,
    amount: toStorage(amount),
    balanceBefore,
    balanceAfter: toStorage(balanceAfter),
  });
  await tx
    .update(walletAccounts)
    .set({ balance: toStorage(balanceAfter), updatedAt: new Date() })
    .where(eq(walletAccounts.id, accountId));
  return toStorage(balanceAfter);
}
