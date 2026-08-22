/**
 * @tokenlens/billing 公共出口。
 * U0 基座（ADR-0003、IMPLEMENTATION §5）：金额值对象与命令指纹；facade createBilling
 * 与 ./wallet、./settlement 子入口随后续迁移单元开放——不预建空壳（铁律 4）。
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
