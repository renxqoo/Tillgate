/**
 * 结算超收可收额（PAYG/订阅共用纯编排）：
 * 可收上界 = 可用（余额 + 授信 − 在途）+ 结算透支地板 debit_floor。
 * 全额超收会使可用敞口为负——深度由 debit_floor 与 DB 触发器强制封顶，
 * 超出部分由调用方以 waived 上报（落 billing_requests.waived_amount）。
 */
import { availableToSpend } from '../../../domain/wallet/exposure.js';
import { Decimal } from '../../../domain/money.js';
import type { WalletStore, WalletTx } from '../../../ports/wallet-store.js';

export async function overCollectCeiling(
  walletStore: WalletStore,
  tx: WalletTx,
  userId: number,
): Promise<Decimal> {
  const rows = await walletStore.userAccountSummaries(tx, userId);
  // 单币种部署（guards 收敛到装配币种）：用户账户行至多一条
  const account = rows.find((row) => row.kind === 'user');
  if (account == null) return new Decimal(0);
  return Decimal.max(
    availableToSpend(account).plus(new Decimal(account.debitFloor ?? '0')),
    new Decimal(0),
  );
}
