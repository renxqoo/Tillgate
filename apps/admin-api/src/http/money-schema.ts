/** 管理面资金输入：JSON 中一律使用十进制字符串，禁止先经过 IEEE-754 number。 */
import { z } from 'zod';
import { Decimal, parseNonNegativeAmount, parsePositiveAmount } from '@ai-gateway/domain';

const MONEY_MAX = new Decimal('1000000000');

function validPositive(raw: string): boolean {
  try {
    return parsePositiveAmount(raw).lte(MONEY_MAX);
  } catch {
    return false;
  }
}

function validNonNegative(raw: string): boolean {
  try {
    return parseNonNegativeAmount(raw).lte(MONEY_MAX);
  } catch {
    return false;
  }
}

function validSignedNonZero(raw: string): boolean {
  if (!/^-?\d{1,20}(?:\.\d{1,18})?$/.test(raw)) return false;
  const magnitude = raw.startsWith('-') ? raw.slice(1) : raw;
  return validPositive(magnitude);
}

export const positiveMoneyString = z.string().refine(validPositive, 'Amount must be a valid positive decimal string within the limit');
export const nonNegativeMoneyString = z.string().refine(validNonNegative, 'Amount must be a valid non-negative decimal string within the limit');
export const signedNonZeroMoneyString = z.string().refine(validSignedNonZero, 'Amount must be a valid non-zero decimal string within the limit');
