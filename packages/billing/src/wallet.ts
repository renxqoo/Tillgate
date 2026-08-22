/**
 * ./wallet 窄子入口：只装配钱包动词（worker 对账/运维工具等单一职责消费方
 * 避免拉入全量 facade）。装配便捷件在 ./composition（app assembly 专用）。
 */
export {
  createWalletApi,
  type WalletApi,
  type WalletEnv,
  type CreditInput,
  type CreditResult,
  type AuthorizeInput,
  type AuthorizeResult,
  type SettleInput,
  type SettleResult,
  type ReleaseInput,
  type ReleaseResult,
  type RefundInput,
  type RefundResult,
  type TransferInput,
  type TransferResult,
  type SetCreditLimitInput,
  type SetCreditLimitResult,
  type StatementQuery,
  type StatementItemView,
} from './application/wallet/wallet.js';
export { BILLING_REF_TYPE } from './application/wallet/authorize.js';
export { BillingErrors } from './domain/errors.js';
