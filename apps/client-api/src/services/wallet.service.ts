/**
 * 钱包读服务：余额摘要 + 腿级流水（游标分页）。资金动词在 @ai-gateway/service
 * wallet（credit 经 auth/payments/redeem 各服务调用）——本文件只是用户面读出口。
 */
import type { AccountSnapshot } from '@ai-gateway/domain';
import type { RunContext, StatementItemView, StatementQuery, WalletApi } from '@ai-gateway/service';

export interface WalletService {
  accounts(ctx: RunContext, userId: number): Promise<AccountSnapshot[]>;
  statement(
    ctx: RunContext,
    input: { userId: number; limit: number; beforeLegId?: number },
  ): Promise<StatementItemView[]>;
}

export function createWalletService(wallet: WalletApi): WalletService {
  return {
    accounts: (ctx, userId) => wallet.accounts(ctx, userId),
    statement: (ctx, input) => {
      const query: StatementQuery = { userId: input.userId, limit: input.limit };
      if (input.beforeLegId != null) query.beforeLegId = input.beforeLegId;
      return wallet.statement(ctx, query);
    },
  };
}
