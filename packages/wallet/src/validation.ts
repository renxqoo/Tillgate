/** 入参校验（zod）：金额/refType/refId/userId/currency 词表与格式——非法即抛，不静默纠正 */
import { z } from 'zod';
import { Decimal, isValidAmountString } from './money';
import {
  InvalidAccountRefError,
  InvalidAmountError,
  InvalidInputError,
  UnknownAccountCodeError,
  UnknownCurrencyError,
  UnknownRefTypeError,
} from './errors';
import { DEFAULT_CURRENCY } from './types';
import type { WalletTelemetry } from './types';

export { DEFAULT_CURRENCY };

/** 正金额（字符串十进制，>0，≤18 位小数） */
const amountSchema = z.string().refine((v) => isValidAmountString(v) && new Decimal(v).gt(0), {
  message: 'amount must be a positive decimal string (up to 18 fractional digits)',
});

/** 非负金额（授信额允许 0 = 收回授信） */
const nonNegativeAmountSchema = z
  .string()
  .refine((v) => isValidAmountString(v) && new Decimal(v).gte(0), {
    message: 'amount must be a non-negative decimal string (up to 18 fractional digits)',
  });

export const refTypeSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: 'refType must be a snake_case business domain identifier',
  });
export const refIdSchema = z.string().min(1).max(128);
export const userIdSchema = z.number().int().positive().safe();
export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, {
    message: 'currency must be an uppercase ISO 4217 three-letter code (e.g. CNY/USD)',
  });
export const accountCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: 'internal account code must be snake_case (e.g. platform_revenue)',
  });
export const memoSchema = z.string().max(255).optional();

export function parseWithWalletError<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new InvalidInputError(field, detail);
  }
  return parsed.data;
}

export function assertOptionalDate(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidInputError(field, 'must be a valid Date');
  }
}

export function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new InvalidInputError(field, 'must be a boolean');
}

export function assertOptionalString(value: unknown, field: string, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > max) {
    throw new InvalidInputError(field, `must be a string of at most ${max} characters`);
  }
}

/** 账户寻址校验：userId（用户账户）或 code（内部科目）二选一；返回币种 */
export function parseAccountRef(
  ref: {
    userId?: number;
    code?: string;
    currency?: string;
  },
  guards?: ValidationGuards,
): string {
  const hasUser = typeof ref.userId === 'number';
  const hasCode = typeof ref.code === 'string';
  if (hasUser === hasCode) {
    throw new InvalidAccountRefError('exactly one of userId or code must be specified');
  }
  const currency = ref.currency ?? guards?.defaultCurrency ?? DEFAULT_CURRENCY;
  parseWithWalletError(currencySchema, currency, 'currency');
  guardCurrency(currency, guards);
  if (hasCode) {
    parseWithWalletError(accountCodeSchema, ref.code, 'account.code');
    if (guards?.accountCodes && !guards.accountCodes.has(ref.code!)) {
      throw new UnknownAccountCodeError(ref.code!, [...guards.accountCodes]);
    }
  } else {
    parseWithWalletError(userIdSchema, ref.userId, 'account.userId');
  }
  return currency;
}

/** 金额字符串 → Decimal（非法抛 InvalidAmountError） */
export function parseAmount(value: string): Decimal {
  const parsed = z.object({ amount: amountSchema }).safeParse({ amount: value });
  if (!parsed.success) throw new InvalidAmountError(value);
  return new Decimal(value);
}

/** 非负金额（授信用） */
export function parseNonNegativeAmount(value: string): Decimal {
  const parsed = z.object({ amount: nonNegativeAmountSchema }).safeParse({ amount: value });
  if (!parsed.success) throw new InvalidAmountError(value);
  return new Decimal(value);
}

/** 守卫集合（可选白名单；undefined = 该维度自由） */
export interface ValidationGuards {
  refTypes?: ReadonlySet<string>;
  currencies?: ReadonlySet<string>;
  accountCodes?: ReadonlySet<string>;
  defaultCurrency?: string;
  telemetry?: WalletTelemetry;
  internalAccountShards?: number;
}

function guardRefType(refType: string, guards?: ValidationGuards): void {
  if (guards?.refTypes && !guards.refTypes.has(refType)) {
    throw new UnknownRefTypeError(refType, [...guards.refTypes]);
  }
}

function guardCurrency(currency: string, guards?: ValidationGuards): void {
  if (guards?.currencies && !guards.currencies.has(currency)) {
    throw new UnknownCurrencyError(currency, [...guards.currencies]);
  }
}

/** 校验「用户 + 币种 + 幂等键」（credit/refund/authorize/credit_line 共用） */
export function parseUserRef(
  input: {
    userId: number;
    refType: string;
    refId: string;
    currency?: string;
    memo?: string;
  },
  guards?: ValidationGuards,
): string {
  const { currency, ...rest } = input;
  parseWithWalletError(
    z.object({
      userId: userIdSchema,
      refType: refTypeSchema,
      refId: refIdSchema,
      memo: memoSchema,
    }),
    rest,
    'wallet input',
  );
  guardRefType(input.refType, guards);
  const resolved = currency ?? guards?.defaultCurrency ?? DEFAULT_CURRENCY;
  parseWithWalletError(currencySchema, resolved, 'currency');
  guardCurrency(resolved, guards);
  return resolved;
}

/** 校验幂等键二元组（settle/release/transfer/freeze 共用） */
export function parseRef(
  input: { refType: string; refId: string; memo?: string },
  guards?: ValidationGuards,
): void {
  parseWithWalletError(
    z.object({ refType: refTypeSchema, refId: refIdSchema, memo: memoSchema }),
    input,
    'reference',
  );
  guardRefType(input.refType, guards);
}

/** 校验对手科目（credit/refund/settle 的 counterparty）——白名单防拼错静默建科目 */
export function parseCounterparty(code: string, guards?: ValidationGuards): void {
  parseWithWalletError(accountCodeSchema, code, 'counterparty');
  if (guards?.accountCodes && !guards.accountCodes.has(code)) {
    throw new UnknownAccountCodeError(code, [...guards.accountCodes]);
  }
}
