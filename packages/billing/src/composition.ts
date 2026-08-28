/**
 * 装配子入口（内部 workspace 契约，非公开 API）：
 * 仅各 app 的 assembly、迁移脚本与 adapter 集成测试可引用；
 * 业务调用方只持有 root index 的 facade。
 */
import type { Db, TxRetryPolicy } from '@tillgate/db';
import { createBilling } from './billing.js';
import { createPostgresWalletStore } from './adapters/postgres/wallet-store.js';
import { createPostgresBillingStore } from './adapters/postgres/billing-store.js';
import type { FundingSourceResolver } from './ports/funding-ports.js';
import type { CreateBillingConfig } from './billing.js';

export { createBilling };
export { readPlatformCurrency } from './adapters/postgres/platform-currency-reader.js';
export {
  createPostgresWalletStore,
  type PostgresWalletStoreOptions,
} from './adapters/postgres/wallet-store.js';
export {
  createPostgresBillingStore,
  type PostgresBillingStoreOptions,
} from './adapters/postgres/billing-store.js';
export {
  createPostgresPaymentOrderStore,
  createPostgresRedeemCodeStore,
} from './adapters/postgres/payment-stores.js';
export { createEpayProvider, createStripeProvider } from './adapters/payments/providers.js';
export type { StripeProviderConfig } from './adapters/payments/providers.js';
export { createPostgresCommissionStatsStore } from './adapters/postgres/commission-stats.js';
export { createPostgresReconcileDiscrepancyStore } from './adapters/postgres/reconcile-discrepancy-store.js';
export type { Billing, CreateBillingConfig, BillingStores } from './billing.js';
/**
 * postgres 一站式装配便捷件：db + 重试策略 → 全套 store → createBilling。
 * 凭证解析（resolver）仍由 app 桥接 accounts/identity——本函数只收它。
 */
export function createPostgresBilling(
  db: Db,
  options: { retry: TxRetryPolicy; resolver: FundingSourceResolver } & Omit<
    CreateBillingConfig,
    'resolver'
  >,
): ReturnType<typeof createBilling> {
  const walletStore = createPostgresWalletStore(db, { retry: options.retry });
  const billingStore = createPostgresBillingStore(db, { retry: options.retry });
  return createBilling(
    {
      walletStore,
      store: billingStore,
      quota: billingStore.quotaStore,
      channels: billingStore.channelStore,
      accounts: billingStore.accountContext,
    },
    {
      guards: options.guards,
      currency: options.currency,
      resolver: options.resolver,
      usageDefectBreaker: options.usageDefectBreaker,
      failurePolicy: options.failurePolicy,
      clock: options.clock,
      outbox: options.outbox,
      onError: options.onError,
      wake: options.wake,
      onSettled: options.onSettled,
      onDead: options.onDead,
    },
  );
}
