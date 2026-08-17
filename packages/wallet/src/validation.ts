/** 入参校验（zod）：金额/refType/refId/userId 词表与格式——非法即抛，不静默纠正 */
import { z } from 'zod';
import { Decimal, isValidAmountString } from './money';
import { InvalidAmountError } from './errors';

/** 正金额（字符串十进制，>0，≤18 位小数） */
const amountSchema = z.string().refine((v) => isValidAmountString(v) && new Decimal(v).gt(0), {
  message: '金额必须为正的十进制字符串（≤18 位小数）',
});

export const refTypeSchema = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_]*$/, {
  message: 'refType 须为 snake_case 业务域标识',
});
export const refIdSchema = z.string().min(1).max(128);
export const userIdSchema = z.number().int().positive();

/** 金额字符串 → Decimal（非法抛 InvalidAmountError） */
export function parseAmount(value: string): Decimal {
  const parsed = z.object({ amount: amountSchema }).safeParse({ amount: value });
  if (!parsed.success) throw new InvalidAmountError(value);
  return new Decimal(value);
}

/** 校验「用户 + 幂等键」三元组（credit/refund/authorize 共用） */
export function parseUserRef(input: { userId: number; refType: string; refId: string }): void {
  z.object({ userId: userIdSchema, refType: refTypeSchema, refId: refIdSchema }).parse(input);
}

/** 校验幂等键二元组（settle/release 共用） */
export function parseRef(input: { refType: string; refId: string }): void {
  z.object({ refType: refTypeSchema, refId: refIdSchema }).parse(input);
}
