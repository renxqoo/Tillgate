/** 冻结单读取（按业务键寻址；CAS 失败后的状态判别依据） */
import { and, eq } from 'drizzle-orm';
import { walletAuthorizations } from './schema';
import type { DbLike } from './internal';
import type { Tx } from './internal';

export async function findAuthorization(
  db: DbLike,
  refType: string,
  refId: string,
): Promise<
  | {
      id: string;
      accountId: string;
      amount: string;
      status: string;
      settledAmount: string | null;
      releaseReason: string | null;
      expiresAt: Date | null;
      authorizeFingerprint: string | null;
      releaseFingerprint: string | null;
    }
  | undefined
> {
  const [row] = await db
    .select()
    .from(walletAuthorizations)
    .where(and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)));
  return row;
}

/** 状态迁移前锁定冻结单；先校验再更新，避免 DB 状态约束抢先泄漏为原始 SQL 错误。 */
export async function lockAuthorization(tx: Tx, refType: string, refId: string) {
  const [row] = await tx
    .select()
    .from(walletAuthorizations)
    .where(and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)))
    .for('update');
  return row;
}
