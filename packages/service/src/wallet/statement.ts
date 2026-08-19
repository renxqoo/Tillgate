/** statement 读侧用例：用户资金流水（腿级，id 倒序游标分页）。 */
import { createRepositories } from '@ai-gateway/repository';
import { normalizeAmount } from '@ai-gateway/domain';
import type { RunContext } from '../context.js';
import { readOnly } from '../context.js';
import type { WalletEnv } from './env.js';

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
  const { db } = env;
  const repos = env.repos ?? createRepositories();
  return async function statement(ctx: RunContext, input: StatementQuery): Promise<StatementItemView[]> {
    const items = await repos.wallet.statementPage(readOnly(ctx, db), {
      userId: input.userId,
      kinds: input.kinds,
      limit: Math.min(200, Math.max(1, input.limit ?? 50)),
      beforeLegId: input.beforeLegId,
    });
    return items.map((item) => ({
      ...item,
      amount: normalizeAmount(item.amount),
      balanceAfter: normalizeAmount(item.balanceAfter),
    }));
  };
}
