/**
 * 死单复核路由（会话）：list（status=dead 专属）+ retry/abandon
 * （幂等键透传；理由必填；乐观锁 expectedRevision）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { operationId } from '@ai-gateway/http';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import type { BillingReviewService } from '../services/billing-review.service.js';
import type { SessionEnv } from '../middleware/session.js';

const listQuery = z.object({
  /** 死单复核面只看 dead（其余状态走正常结算管线） */
  status: z.literal('dead'),
});

const decisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

const requestIdParam = (raw: string): string => {
  if (!/^[0-9a-f-]{16,64}$/.test(raw)) {
    throw new AppError(400, 'invalid_param', 'requestId must be a uuid');
  }
  return raw;
};

export function billingOperationsRoutes(
  service: BillingReviewService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/billing-operations', session, async (c) => {
    const query = listQuery.parse(c.req.query());
    void query;
    const parts = parseListQuery(c.req.query(), ['id'], 'id');
    return c.json(await service.list(adminCtxOf(c), { limit: parts.limit, offset: parts.offset }));
  });

  app.post('/v1/billing-operations/:requestId/retry', session, async (c) => {
    const requestId = requestIdParam(c.req.param('requestId'));
    const body = decisionSchema.parse(await c.req.json());
    return c.json(
      await service.retry(adminCtxOf(c), {
        adminId: c.get('adminId'),
        operationId: operationId(c),
        requestId,
        ...body,
      }),
    );
  });

  app.post('/v1/billing-operations/:requestId/abandon', session, async (c) => {
    const requestId = requestIdParam(c.req.param('requestId'));
    const body = decisionSchema.parse(await c.req.json());
    return c.json(
      await service.abandon(adminCtxOf(c), {
        adminId: c.get('adminId'),
        operationId: operationId(c),
        requestId,
        ...body,
      }),
    );
  });

  return app;
}
