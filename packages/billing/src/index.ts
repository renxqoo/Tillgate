/**
 * @tokenlens/billing 公共出口。
 * U0 基座（金额/指纹）+ U1 钱包垂直（domain 定律 + application 动词）。
 * facade createBilling 与 ./settlement 子入口随后续迁移单元开放——不预建空壳（铁律 4）。
 * adapters/postgres 不从根出口导出：装配走 ./composition（总纲 §5.3）。
 */

// ---- 领域错误目录 ----
export { BillingErrors } from './domain/errors.js';

// ---- 金额（DESIGN §2.2 全包唯一金额契约） ----
export {
  Decimal,
  toStorage,
  normalizeAmount,
  isValidAmountString,
  parsePositiveAmount,
  parseNonNegativeAmount,
} from './domain/money.js';

// ---- 命令指纹（DESIGN §2.3 全包唯一指纹契约） ----
export {
  canonicalJson,
  fingerprintOf,
  commandFingerprint,
  assertCommandFingerprint,
} from './domain/fingerprint.js';
export type { FingerprintValue } from './domain/fingerprint.js';

// ---- 钱包定律（U1a：复式过账 / 出账口径 / 冻结单状态机 / 白名单） ----
export { OUTSIDE_ACCOUNT, REVENUE_ACCOUNT } from './domain/wallet/accounts.js';
export type { AccountRef, AccountSnapshot } from './domain/wallet/accounts.js';
export {
  assertRefType,
  assertCurrency,
  assertInternalCode,
  assertRefId,
} from './domain/wallet/guards.js';
export type { WalletGuards } from './domain/wallet/guards.js';
export {
  availableToSpend,
  assertCanDebit,
  assertCreditLimitCoversExposure,
} from './domain/wallet/exposure.js';
export type { DebitGuard } from './domain/wallet/exposure.js';
export { assertSettleable, assertReleasable } from './domain/wallet/authorization.js';
export type { AuthorizationStatus, AuthorizationSnapshot } from './domain/wallet/authorization.js';
export { isAuditKind, validatePosting, legBalanceAfter } from './domain/wallet/posting.js';
export type { TransactionKind, PostingLegSpec, PostingSpec } from './domain/wallet/posting.js';

// ---- 钱包动词（U1b：application 编排 + 存储 port） ----
export { createWalletApi } from './application/wallet/wallet.js';
export { BILLING_REF_TYPE } from './application/wallet/authorize.js';
export type { WalletApi, WalletEnv } from './application/wallet/wallet.js';
export type { CreditInput, CreditResult } from './application/wallet/credit.js';
export type { AuthorizeInput, AuthorizeResult } from './application/wallet/authorize.js';
export type { SettleInput, SettleResult } from './application/wallet/settle.js';
export type { ReleaseInput, ReleaseResult } from './application/wallet/release.js';
export type { RefundInput, RefundResult } from './application/wallet/refund.js';
export type { TransferInput, TransferResult } from './application/wallet/transfer.js';
export type {
  SetCreditLimitInput,
  SetCreditLimitResult,
} from './application/wallet/credit-line.js';
export type { StatementQuery, StatementItemView } from './application/wallet/statement.js';
export type {
  WalletStore,
  WalletConn,
  TransactionHeader,
  StatementItemRow,
} from './ports/wallet-store.js';
