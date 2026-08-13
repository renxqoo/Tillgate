// 金额计算包：单位统一为「元」，DB 存 numeric(38,18)，运算用 decimal.js（账本永不 round）。
export { calcAmount } from './amount.js';
export type { AmountInput } from './amount.js';
export { estimateMaxCost, requiredReservation } from './reservation.js';
export type { ReservationEstimateInput } from './reservation.js';
export { Decimal, PRICE_PER_MILLION, toDecimal, toStorage } from './units.js';
