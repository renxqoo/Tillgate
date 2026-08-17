/** 冻结单读取（按业务键寻址；CAS 失败后的状态判别依据） */
import { and, eq } from 'drizzle-orm';
import { walletAuthorizations } from './schema';
import type { DbLike } from './internal';

export async function findAuthorization(
  db: DbLike,
  refType: string,
  refId: string,
): Promise<{
  id: string;
  userId: number;
  currency: string;
  amount: string;
  status: string;
  settledAmount: string | null;
  releaseReason: string | null;
  expiresAt: Date | null;
} | undefined> {
  const [row] = await db
    .select()
    .from(walletAuthorizations)
    .where(and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)));
  return row;
}
