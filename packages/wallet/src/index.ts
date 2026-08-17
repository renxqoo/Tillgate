/** @ai-gateway/wallet 出口：装配层 createWallet + 各动词（可自带 db 单独用）+ 契约类型 */
export { createWallet } from './wallet';
export { credit } from './credit';
export { authorize } from './authorize';
export { settle } from './settle';
export { release, releaseExpired } from './release';
export { refund } from './refund';
export { setCreditLimit } from './credit-line';
export { accounts, balance } from './balance';
export type {
  Wallet,
  CreditInput,
  AuthorizeInput,
  SettleInput,
  ReleaseInput,
  RefundInput,
  CreditLineInput,
  CreditResult,
  AuthorizeResult,
  SettleResult,
  ReleaseResult,
  CreditLineResult,
  AccountSummary,
} from './types';
export { DEFAULT_CURRENCY } from './types';
export { provision, deprovision } from './schema';
export { walletAccounts, walletAuthorizations, walletTransactions } from './schema';
export {
  WalletError,
  InvalidAmountError,
  InsufficientBalanceError,
  AuthorizationNotFoundError,
  AuthorizationNotActiveError,
  SettleExceedsHoldError,
  RefKeyConflictError,
  CreditLimitConflictError,
} from './errors';
export { Decimal, normalizeAmount, toStorage } from './money';
