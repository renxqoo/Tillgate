/** @ai-gateway/wallet 出口：装配层 createWallet + 各动词（可自带 db 单独用）+ 契约类型 */
export { createWallet } from './wallet';
export { credit } from './credit';
export { authorize } from './authorize';
export { settle } from './settle';
export { release, releaseExpired } from './release';
export { refund } from './refund';
export { transfer } from './transfer';
export { setCreditLimit } from './credit-line';
export { freeze } from './freeze';
export { accounts, balance } from './balance';
export type {
  Wallet,
  AccountRef,
  CreditInput,
  AuthorizeInput,
  SettleInput,
  ReleaseInput,
  RefundInput,
  TransferInput,
  CreditLineInput,
  FreezeInput,
  CreditResult,
  AuthorizeResult,
  SettleResult,
  ReleaseResult,
  TransferResult,
  CreditLineResult,
  FreezeResult,
  AccountSummary,
} from './types';
export {
  DEFAULT_CURRENCY,
  OUTSIDE_ACCOUNT,
  REVENUE_ACCOUNT,
} from './types';
export { provision, deprovision } from './schema';
export {
  walletAccounts,
  walletAuthorizations,
  walletTransactions,
  walletLegs,
} from './schema';
export {
  WalletError,
  WalletInternalError,
  InvalidAmountError,
  InvalidAccountRefError,
  InsufficientBalanceError,
  AuthorizationNotFoundError,
  AuthorizationNotActiveError,
  SettleExceedsHoldError,
  RefKeyConflictError,
  CreditLimitConflictError,
  FrozenAccountError,
  SameAccountTransferError,
  CurrencyMismatchError,
} from './errors';
export { Decimal, normalizeAmount, toStorage } from './money';
