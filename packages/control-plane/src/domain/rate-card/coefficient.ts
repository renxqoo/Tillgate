/**
 * 费率卡系数域规则（纯函数）：域校验与 3 位小数格式化。
 * 系数 numeric(6,3)：0.001–9.999；API 只收十进制字符串，落库与回显恒 3 位小数。
 * 解析优先级（model > group > global）的消费方在 billing/inference——本包只管配置面。
 */
import Decimal from 'decimal.js';
import { controlPlaneErrors } from '../../errors';

/** 系数域：单个整数位 0-9 + 0-3 位小数，且大于 0 */
const COEFFICIENT_PATTERN = /^(?:[0-9](?:\.\d{1,3})?)$/;

/** 系数落库/回显口径：3 位小数字符串（numeric(6,3)） */
export function formatCoefficient(raw: string): string {
  return new Decimal(raw).toFixed(3);
}

/** 系数域校验：只收十进制字符串（number 形态在包边界拒绝——资金值禁止经 IEEE-754）；'0'/'1.0001'/'10' 一律拒绝 */
export function validateCoefficient(raw: string): string {
  if (typeof raw !== 'string' || !COEFFICIENT_PATTERN.test(raw) || /^0(?:\.0+)?$/.test(raw)) {
    throw controlPlaneErrors.business('invalid_coefficient', { coefficient: String(raw) });
  }
  return formatCoefficient(raw);
}
