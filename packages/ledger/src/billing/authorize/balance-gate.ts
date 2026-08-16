import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import type { Decimal } from '@ai-gateway/money';
import { toDecimal } from '@ai-gateway/money';
import type { DbTx } from '../types.js';
import { InsufficientBalanceError } from '../errors.js';

/**
 * 余额来源闸（拆自 authorize 事务，行为零变更）：
 * 只扣余额（含信用透支）。可用信用 = balance + credit_limit − reserved_balance。
 * 0 元（免费模型）不校验余额（fast-path 由编排层处理）。
 */
export async function assertBalanceGate(
  tx: DbTx,
  userId: number,
  amountDec: Decimal,
): Promise<void> {
  const user = await tx.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true, reservedBalance: true, creditLimit: true },
  });
  if (!user) throw new InsufficientBalanceError(userId, '0');
  const available = toDecimal(user.balance)
    .plus(user.creditLimit)
    .minus(user.reservedBalance);
  if (!amountDec.isZero() && available.lt(amountDec)) {
    throw new InsufficientBalanceError(
      userId,
      available.toString(),
      user.balance,
      user.reservedBalance,
      user.creditLimit,
    );
  }
}
