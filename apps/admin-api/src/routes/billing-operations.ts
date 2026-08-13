import { Hono } from 'hono';
import { z } from 'zod';
import { BillingOperationError } from '@ai-gateway/ledger';
import { HttpError, jsonBody, operationId, query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

const listSchema = z.object({
  status: z.enum(['dead', 'uncertain']),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

const decisionBase = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

const usageReceiptSchema = z.object({
  requestId: z.string().uuid(),
  userId: z.number().int().positive(),
  apiKeyId: z.number().int().positive().nullable(),
  appId: z.number().int().positive().nullable(),
  credentialType: z.string().min(1).max(16),
  externalModel: z.string().min(1),
  realModel: z.string().min(1),
  channelId: z.number().int().positive().nullable(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimated: z.boolean(),
  }),
  inputPrice: z.string(),
  outputPrice: z.string(),
  cacheInputPrice: z.string(),
  coefficient: z.string(),
  durationMs: z.number().int().nonnegative(),
  stream: z.boolean(),
  streamAborted: z.boolean(),
  mappingId: z.number().int().positive(),
  billingPolicyFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

const resolveSchema = z.discriminatedUnion('decision', [
  decisionBase.extend({ decision: z.literal('confirmed_no_charge') }),
  decisionBase.extend({
    decision: z.literal('provider_receipt_recovered'),
    receipt: usageReceiptSchema,
  }),
]);

function mapError(error: unknown): never {
  if (error instanceof BillingOperationError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid_receipt' ? 422 : 409;
    throw new HttpError(status, `BILLING_${error.code.toUpperCase()}`, error.message);
  }
  throw error;
}

/** 资金异常复核只暴露受审计领域命令，不提供通用 status update。 */
export function billingOperationsRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', query(listSchema), async (c) => {
      const input = c.req.valid('query');
      return c.json({
        items: await s.billingOperations.listCases({
          status: input.status,
          limit: input.limit,
          before: input.before ? new Date(input.before) : undefined,
        }),
      });
    })
    .post('/:requestId/retry', jsonBody(decisionBase), async (c) => {
      try {
        return c.json(
          await s.billingOperations.retryDead({
            operationId: operationId(c),
            requestId: c.req.param('requestId'),
            adminId: c.get('adminId'),
            ...c.req.valid('json'),
          }),
        );
      } catch (error) {
        return mapError(error);
      }
    })
    .post('/:requestId/resolve', jsonBody(resolveSchema), async (c) => {
      try {
        const body = c.req.valid('json');
        return c.json(
          await s.billingOperations.resolveUncertain({
            operationId: operationId(c),
            requestId: c.req.param('requestId'),
            adminId: c.get('adminId'),
            ...body,
          }),
        );
      } catch (error) {
        return mapError(error);
      }
    });
}
