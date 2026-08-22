/** accounts 读侧动词：用户全部币种账户摘要。金额出口统一规范化——DB numeric 尾零不外泄。 */
import { normalizeAmount } from '../../domain/money.js';
import type { AccountSnapshot } from '../../domain/wallet/accounts.js';
import type { WalletEnv } from './wallet.js';

export function createAccountsUseCase(env: WalletEnv) {
  const { store } = env;
  return async function accounts(userId: number): Promise<AccountSnapshot[]> {
    const rows = await store.read((conn) => store.userAccountSummaries(conn, userId));
    return rows.map((row) => ({
      ...row,
      balance: normalizeAmount(row.balance),
      inFlight: normalizeAmount(row.inFlight),
      creditLimit: normalizeAmount(row.creditLimit),
    }));
  };
}
