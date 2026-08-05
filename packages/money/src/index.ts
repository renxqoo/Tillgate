// 金额计算包（重构后：元 + decimal 全精度）
// 废除厘/LI_PER_YUAN/COEFFICIENT_SCALE/coefficientMilli/liToYuan/yuanToLi 等整数厘相关 API。
// 单位统一为「元」，DB 存 numeric(24,18)，运算用 decimal.js。
export { calcAmount } from './amount.js';
export type { AmountInput } from './amount.js';
export { calcHold, estimateMaxCost } from './hold.js';
export type { HoldEstimateInput } from './hold.js';
export { deductQuota, settleAgainstHold } from './quota.js';
export { Decimal, PRICE_PER_MILLION, toCents, toDecimal, toStorage } from './units.js';
