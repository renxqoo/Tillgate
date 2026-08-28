/**
 * 管理面资金输入口径：
 * JSON 中一律使用十进制字符串，禁止先经过 IEEE-754 number——
 * 指数记法（'1e999'/'1e21'）与超界值在包边界拒绝，绝不溢出到 PG 500。
 */
import Decimal from 'decimal.js';

/** 管理面资金上限（10 亿元——超出即运营输入事故） */
const MONEY_MAX = new Decimal('1000000000');

/** 纯十进制形状：1-20 位整数 + 0-18 位小数（不接受指数/符号/前导垃圾） */
const DECIMAL_PATTERN = /^\d{1,20}(?:\.\d{1,18})?$/;

/** 解析为非负金额（形状 + ≤MONEY_MAX）；非法返回 null——调用方按单元抛目录错误 */
export function parseNonNegativeAmount(raw: string): Decimal | null {
  if (!DECIMAL_PATTERN.test(raw)) return null;
  const value = new Decimal(raw);
  return value.lte(MONEY_MAX) ? value : null;
}

/** 解析为正金额（非零）；非法返回 null */
export function parsePositiveAmount(raw: string): Decimal | null {
  const value = parseNonNegativeAmount(raw);
  return value != null && value.gt(0) ? value : null;
}

/** 调账金额：非零带符号（幅度仍须 ≤MONEY_MAX 且为纯十进制）；非法返回 null */
export function parseSignedNonZeroAmount(raw: string): Decimal | null {
  const magnitude = raw.startsWith('-') ? raw.slice(1) : raw;
  if (!/^-?\d{1,20}(?:\.\d{1,18})?$/.test(raw)) return null;
  const value = parsePositiveAmount(magnitude);
  if (value == null) return null;
  return raw.startsWith('-') ? value.neg() : value;
}
