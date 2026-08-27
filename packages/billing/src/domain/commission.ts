/**
 * 佣金入账额（纯函数）：
 * 日合计 × 费率全精度相乘后，按落库尺度（18 位小数）ROUND_FLOOR 收敛。
 *
 * - floor：派生支付额宁可少付不多付（差额 ≤ 1e-18 元，低于落库尺度不可表示）；
 * - 「账本永不 round」约束账本内加减运算——派生额带着 >18 位小数去撞
 *   `parsePositiveAmount` 落库防线会被 out_of_scale 永久拒绝、幂等自然键
 *   建不出来（曾致邀请人当日佣金永久丢失）；
 * - floor 到 0 的尘埃额由调用方按非正数跳过（不可表示，不入账）。
 */
import { Decimal } from './money.js';

/** 佣金收敛尺度：与 numeric(38,18) 小数位对齐（money.ts AMOUNT_PATTERN 上限） */
export const COMMISSION_SCALE_DP = 18;

/** 佣金入账额 = floor(合计 × 费率, 18 位小数) */
export function commissionCreditAmount(total: string, rate: string): Decimal {
  return new Decimal(total)
    .times(new Decimal(rate))
    .toDecimalPlaces(COMMISSION_SCALE_DP, Decimal.ROUND_FLOOR);
}
