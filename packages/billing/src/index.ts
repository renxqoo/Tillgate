/**
 * @tokenlens/billing 公共出口。
 * U0 基座 + U1a 钱包定律（ADR-0003、IMPLEMENTATION §5）；facade createBilling 与
 * ./wallet、./settlement 子入口随后续迁移单元开放——不预建空壳（铁律 4）。
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
export { canonicalJson, fingerprintOf, commandFingerprint } from './domain/fingerprint.js';
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
