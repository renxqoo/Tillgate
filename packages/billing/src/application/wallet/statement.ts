/** statement 读侧动词：用户资金流水（腿级，id 倒序游标分页）。 */
import { normalizeAmount } from '../../domain/money.js';
import type { StatementItemRow } from '../../ports/wallet-store.js';
import type { WalletEnv } from './wallet.js';

export interface StatementQuery {
  userId: number;
  kinds?: readonly string[];
  limit?: number;
  beforeLegId?: number;
}

/** 流水出口视图（金额已规范化） */
export interface StatementItemView {
  legId: number;
  transactionKind: string;
  refType: string;
  refId: string;
  amount: string;
  balanceAfter: string;
  memo: string | null;
  createdAt: Date;
}

export function createStatementUseCase(env: WalletEnv) {
  const { store } = env;
  return async function statement(input: StatementQuery): Promise<StatementItemView[]> {
    const items: StatementItemRow[] = await store.read((conn) =>
      store.statementPage(conn, {
        userId: input.userId,
        kinds: input.kinds,
        limit: Math.min(200, Math.max(1, input.limit ?? 50)),
        beforeLegId: input.beforeLegId,
      }),
    );
    return items.map((item) => ({
      ...item,
      amount: normalizeAmount(item.amount),
      balanceAfter: normalizeAmount(item.balanceAfter),
    }));
  };
}
