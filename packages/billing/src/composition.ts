/**
 * 装配子入口（内部 workspace 契约，非公开 API——总纲 §5.3）：
 * 仅各 app 的 assembly、迁移脚本与 adapter 集成测试可引用；
 * 业务调用方只持有 root index 的 facade。
 */
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
