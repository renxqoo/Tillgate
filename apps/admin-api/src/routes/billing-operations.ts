import { Hono } from 'hono';
import { z } from 'zod';
import { BillingOperationError } from '@ai-gateway/ledger';
import {
  HttpError, jsonBody, operationId, query,
  paginateQuery, paginationQuerySchema, buildList,
  type KnownErrorCode,
} from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

const listSchema = paginationQuerySchema.extend({
  status: z.literal('dead'),
});

const decisionBase = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

/** BillingOperationError → HTTP（表驱动：状态码/码名由注册表单一真相给出） */
const BILLING_OP_CODE: Record<BillingOperationError['code'], KnownErrorCode> = {
  not_found: 'BILLING_NOT_FOUND',
  state_conflict: 'BILLING_STATE_CONFLICT',
  idempotency_conflict: 'BILLING_IDEMPOTENCY_CONFLICT',
  invalid_receipt: 'BILLING_INVALID_RECEIPT',
};

function mapError(error: unknown): never {
  if (error instanceof BillingOperationError) {
    throw new HttpError(BILLING_OP_CODE[error.code], error.message);
  }
  throw error;
}

/** 资金异常复核只暴露受审计领域命令，不提供通用 status update。 */
export function billingOperationsRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', query(listSchema), async (c) => {
      const input = c.req.valid('query');
      const { page, limit, offset } = buildList(input);
      return c.json(
        await paginateQuery(
          page,
          s.billingOperations.listCases({ status: input.status, limit, offset }),
          s.billingOperations.countCases(input.status).then((count) => [{ count }]),
        ),
      );
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
    // 废弃 dead 单：确认不收费并释放全部预扣（与 retry 二选一的人工处置）
    .post('/:requestId/abandon', jsonBody(decisionBase), async (c) => {
      try {
        return c.json(
          await s.billingOperations.abandonDead({
            operationId: operationId(c),
            requestId: c.req.param('requestId'),
            adminId: c.get('adminId'),
            ...c.req.valid('json'),
          }),
        );
      } catch (error) {
        return mapError(error);
      }
    });
}
