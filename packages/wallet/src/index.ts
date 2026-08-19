/** 生产安全出口：configured Wallet Facade + 契约类型/错误。 */
export { createWallet } from './wallet';
export type {
  Wallet,
  AccountRef,
  TxInput,
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
  CreateWalletOptions,
  StatementInput,
  StatementItem,
  StatementResult,
  StatementCounterparty,
  WalletTelemetry,
  WalletOperationEvent,
  WalletTransactionRetryEvent,
} from './types';
export { DEFAULT_CURRENCY, OUTSIDE_ACCOUNT, REVENUE_ACCOUNT } from './types';
/** 事务注入句柄类型（input.tx 的形状；消费方在自己的事务里传给动词） */
export type { DbLike } from './internal';
/** 任意 schema 绑定的库句柄（createWallet 入参；消费方持 schema-bound Db 直传） */
export type { AnyPgDatabase } from './internal';
export {
  WalletError,
  WalletInternalError,
  InvalidAmountError,
  InvalidInputError,
  InvalidAccountRefError,
  InsufficientBalanceError,
  InsufficientCashError,
  AuthorizationNotFoundError,
  AuthorizationNotActiveError,
  SettleExceedsHoldError,
  RefKeyConflictError,
  IdempotencyConflictError,
  ReservationError,
  type ReservationErrorCode,
  CreditLimitConflictError,
  UnknownAccountCodeError,
  UnknownRefTypeError,
  UnknownCurrencyError,
  FrozenAccountError,
  SameAccountTransferError,
  CurrencyMismatchError,
} from './errors';
