/**
 * 订阅管理动词契约。
 * 资金动词幂等键经 operationId（http 货架;idempotency-key 头或服务端 UUID）。
 */
import * as z from 'zod';

const SEATS_MAX = 1000;

const changeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX).default(1),
});

const grantSchema = z.object({ userId: z.number().int().positive() });

export const subscriptionsContracts = {
  change: changeSchema,
  grant: grantSchema,
} as const;
