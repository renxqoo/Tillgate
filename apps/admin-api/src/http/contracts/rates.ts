/**
 * 费率卡/fx 域契约（v1 rate-cards.ts + fx.ts zod 面平移）。
 * 系数 numeric(6,3)：0.001..9.999,只收十进制字符串。
 */
import * as z from 'zod';

export const RATE_CARD_SORTS = ['id', 'name', 'status', 'createdAt'] as const;
export const RATE_CARD_USER_SORTS = ['id', 'subject', 'createdAt'] as const;

const coefficient = z
  .string()
  .regex(/^(?:[0-9](?:\.\d{1,3})?)$/)
  .refine((value) => value !== '0' && !/^0\.0+$/.test(value), 'Coefficient must be greater than 0');

const rateCardCreateSchema = z.object({
  name: z.string().min(1).max(32),
  description: z.string().max(255).optional(),
  coefficient,
});

const rateCardUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(255).nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
  coefficient: coefficient.optional(),
});

const fxOverrideSchema = z.object({ rate: z.coerce.string().min(1).max(16) });
const fxBufferSchema = z.object({ bufferPct: z.coerce.string().min(1).max(8) });
const fxRefreshSchema = z.object({ force: z.boolean().optional() });

export const rateCardsContracts = {
  create: rateCardCreateSchema,
  update: rateCardUpdateSchema,
} as const;

export const fxCatalogContracts = {
  override: fxOverrideSchema,
  buffer: fxBufferSchema,
  refresh: fxRefreshSchema,
} as const;
