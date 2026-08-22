/**
 * 限额域(表驱动,v1 domain/key-limits.ts + 路由 zod 收敛):
 * 金额类上限用精确十进制字符串,拒绝科学计数法/NaN/负数/超上界;
 * 频率类(rpm/tpm)是正整数且 ≤ 注入上界。
 * 上界是可变阈值 → policy 必填注入(v1 等价 '1000000000000' / 1e6 / 1e8)。
 */
import Decimal from 'decimal.js';

export interface LimitPolicy {
  /** 金额类上限的十进制字符串上界(v1 等价 '1000000000000') */
  readonly amountLimitUpper: string;
  /** rpm 上界(v1 等价 1_000_000) */
  readonly rpmLimitMax: number;
  /** tpm 上界(v1 等价 100_000_000) */
  readonly tpmLimitMax: number;
}

/** 纯十进制形状:非科学计数法、非 NaN/Infinity,小数位任意(精度由 DB numeric(38,18) 收口) */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

export interface AmountLimitRule {
  readonly upper: string;
}

/**
 * 解析金额上限:正数、十进制串、≤ upper。
 * 返回规范化字符串(去指数形态),非法返回 null。
 * v1 语义锚:结构性拒绝 '1e21'、22 位整数、负数、NaN、超过 1e12 业务上界。
 */
export function parseAmountLimit(input: string, upper: string): string | null {
  if (!DECIMAL_RE.test(input)) return null;
  let value: Decimal;
  try {
    value = new Decimal(input);
  } catch {
    return null;
  }
  // 注意:Decimal.isPositive() 对 0 返回 true(零为正号),此处须显式 >0
  if (!value.greaterThan(0)) return null;
  if (value.greaterThan(new Decimal(upper))) return null;
  return input;
}

/** 管理面金额口径:非负且 ≤ 上界(允许 0=即日全拒;v1 admin zod 语义) */
export function isNonNegativeAmountWithin(input: string, upper: string): boolean {
  if (!DECIMAL_RE.test(input)) return false;
  try {
    const value = new Decimal(input);
    return value.greaterThanOrEqualTo(0) && value.lessThanOrEqualTo(new Decimal(upper));
  } catch {
    return false;
  }
}

export function isPositiveAmount(input: string): boolean {
  if (!DECIMAL_RE.test(input)) return false;
  try {
    // 显式 >0(Decimal.isPositive 对 0 为 true)
    return new Decimal(input).greaterThan(0);
  } catch {
    return false;
  }
}

/** 频率限额:正整数(≥1)且 ≤ max;null=清空(不限)语义由调用方处理 */
export function parseRateLimit(input: number, max: number): number | null {
  if (!Number.isSafeInteger(input)) return null;
  if (input < 1) return null;
  if (input > max) return null;
  return input;
}
