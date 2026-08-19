/**
 * accounts 读侧用例：用户全部币种账户摘要。金额出口统一规范化——DB numeric 尾零不外泄。
 */
import { createRepositories } from '@ai-gateway/repository';
import type { AccountSnapshot } from '@ai-gateway/domain';
import { normalizeAmount } from '@ai-gateway/domain';
import type { RunContext } from '../context.js';
import { readOnly } from '../context.js';
import type { WalletEnv } from './env.js';

export function createAccountsUseCase(env: WalletEnv) {
  const { db } = env;
  const repos = env.repos ?? createRepositories();
  return async function accounts(ctx: RunContext, userId: number): Promise<AccountSnapshot[]> {
    const rows = await repos.wallet.userAccountSummaries(readOnly(ctx, db), userId);
    return rows.map((row) => ({
      ...row,
      balance: normalizeAmount(row.balance),
      inFlight: normalizeAmount(row.inFlight),
      creditLimit: normalizeAmount(row.creditLimit),
    })) as AccountSnapshot[];
  };
}
