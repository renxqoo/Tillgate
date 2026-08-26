/**
 * 资金面契约：钱包流水（游标分页）/ 兑换 / 支付下单 / 订阅购买与变更。
 * 金额输入全部走 billing 域校验（isValidAmountInput：十进制字符串正数）。
 */
import * as z from 'zod';
import { isValidAmountInput } from '@tillgate/billing';
import { listQuerySchema } from './shared.js';

export const statementQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  beforeLegId: z.coerce.number().int().positive().optional(),
});

export const redeemSchema = z.object({ code: z.string().trim().min(1).max(128) });

export const redeemHistoryQuerySchema = listQuerySchema;

export const createOrderSchema = z.object({
  amount: z.string().refine(isValidAmountInput, 'Must be a positive amount'),
  provider: z.enum(['epay', 'stripe']).optional(),
});

export const ordersListQuerySchema = listQuerySchema;

/** 订单号为 uuid 形态（缺这层判型会把任意串带进存储层） */
export const orderIdPattern = /^[0-9a-f-]{36}$/i;

/** 席位上界：防 numeric 溢出与恶意超大值（超此规模走线下） */
export const SEATS_MAX = 1000;

export const purchaseSchema = z.object({
  planId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX).optional(),
});

export const planChangeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX),
});

export const subscriptionIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** 幂等键头（v1 口径：缺省服务端生成；非法形态 400 不静默改写） */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
