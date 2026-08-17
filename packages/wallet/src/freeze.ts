/** freeze：账户冻结/解冻（风控）——零额审计交易；冻结账户拒绝一切资金变动（查询不受限） */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { WalletInternalError } from './errors';
import { walletAccounts, walletTransactions } from './schema';
import { resolveAccount } from './account';
import { applyLeg } from './legs';
import { isUniqueViolation, runTx } from './internal';
import { replayFreeze } from './replay';
import { parseAccountRef, parseRef } from './validation';
import { Decimal } from './money';
import type { FreezeInput, FreezeResult } from './types';

export async function freeze(db: NodePgDatabase, input: FreezeInput): Promise<FreezeResult> {
  parseRef({ refType: input.refType, refId: input.refId });
  const currency = parseAccountRef(input.target);

  try {
    return await runTx(db, async (tx) => {
      const accountId = await resolveAccount(tx, input.target, currency);
      // 冻结操作本身允许作用于已冻结账户（幂等再冻结）——用原生行锁，不走 lockAccounts 的冻结检查
      const [account] = await tx
        .select({ balance: walletAccounts.balance })
        .from(walletAccounts)
        .where(eq(walletAccounts.id, accountId))
        .for('update');
      if (!account) throw new WalletInternalError('freeze.target_missing');
      const [header] = await tx
        .insert(walletTransactions)
        .values({
          kind: 'freeze',
          refType: input.refType,
          refId: input.refId,
          memo: input.memo ?? (input.frozen ? 'frozen' : 'unfrozen'),
        })
        .returning({ id: walletTransactions.id });
      if (!header) throw new WalletInternalError('freeze.insert');
      await applyLeg(tx, header.id, accountId, currency, new Decimal(0), account.balance);
      await tx
        .update(walletAccounts)
        .set({ status: input.frozen ? 'frozen' : 'active', updatedAt: new Date() })
        .where(eq(walletAccounts.id, accountId));
      return {
        transactionId: header.id,
        frozen: input.frozen,
        replayed: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const accountId = await resolveAccount(db, input.target, currency);
      return replayFreeze(db, input.refType, input.refId, accountId);
    }
    throw error;
  }
}
