/**
 * billing 管理域契约。
 * 价格/额度仅精确十进制字符串;kind 不可变 = .strictObject 拒未知键。
 * payment-orders 列表排序白名单（单一真相 = billing 包词表,不复制）。
 */
import * as z from 'zod';
import { PAYMENT_ORDER_SORT_FIELDS } from '@tillgate/billing';
import { AdminErrors } from '../error-face';
import { positiveMoneyString } from './common';

export const PLAN_SORTS = ['id', 'name', 'status', 'price', 'sortOrder'] as const;
export const BATCH_SORTS = ['id', 'name', 'amount', 'createdAt'] as const;
export const ORDER_SORTS = PAYMENT_ORDER_SORT_FIELDS;
export const CODE_SORTS = ['id', 'usedAt'] as const;

const planCreateSchema = z.strictObject({
  name: z.string().min(1).max(32),
  kind: z.enum(['subscription', 'pack']).optional(),
  sortOrder: z.number().int().positive().nullable().optional(),
  price: positiveMoneyString,
  periodDays: z.number().int().min(0).max(3650).optional(),
  quotaAmount: positiveMoneyString,
  allowSeats: z.boolean().optional(),
});

const planUpdateSchema = z.strictObject({
  name: z.string().min(1).max(32).optional(),
  sortOrder: z.number().int().positive().nullable().optional(),
  price: positiveMoneyString.optional(),
  periodDays: z.number().int().min(0).max(3650).optional(),
  quotaAmount: positiveMoneyString.optional(),
  allowSeats: z.boolean().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

const batchCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  amount: positiveMoneyString,
  count: z.number().int().min(1).max(10_000),
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid expiration time format')
    .optional(),
});

const codesQueryExtra = z.object({
  status: z.coerce.number().int().min(0).max(2).optional(),
});

/** 死单复核面只看 dead（其余状态走正常结算管线） */
const deadListQuery = z.object({ status: z.literal('dead') });

const decisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

/** requestId 路径参数:uuid 形状 */
export function requestIdParam(raw: string): string {
  if (!/^[0-9a-f-]{16,64}$/.test(raw)) {
    throw AdminErrors.business('invalid_param', {
      field: 'requestId',
      reason: 'must be a uuid',
    });
  }
  return raw;
}

export const plansContracts = { create: planCreateSchema, update: planUpdateSchema } as const;
export const redeemContracts = { create: batchCreateSchema, codesQueryExtra } as const;
export const reviewContracts = { deadListQuery, decision: decisionSchema } as const;
