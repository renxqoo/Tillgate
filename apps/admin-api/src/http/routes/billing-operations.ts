/**
 * 死单复核路由（P1;v1 routes/billing-operations.ts 平移）：list（status=dead 专属）
 * + retry/abandon（幂等键透传;理由必填;乐观锁 expectedRevision）。
 * 复核审计在 billing 用例内同事务（reviewAuditTx 桥）——路由层零审计。
 */
import { Hono } from 'hono';
import type { SettlementApi } from '@tillgate/billing';
import { operationId } from '@tillgate/http';
import { listEnvelope, parseListQuery } from '../contracts/common';
import { requestIdParam, reviewContracts } from '../contracts/billing-admin';
import { toDeadCaseWireRow } from '../presenters/billing';
import type { SessionEnv } from '../middleware/session';

export interface BillingOperationsRoutesDeps {
  readonly review: SettlementApi['review'];
}

export function billingOperationsRoutes(deps: BillingOperationsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/billing-operations', async (c) => {
    reviewContracts.deadListQuery.parse(c.req.query());
    const parts = parseListQuery(c.req.query(), ['id'], 'id');
    const page = await deps.review.listDead({ limit: parts.limit, offset: parts.offset });
    return c.json(listEnvelope(page.rows.map(toDeadCaseWireRow), page.total, parts));
  });

  app.post('/v1/billing-operations/:requestId/retry', async (c) => {
    const requestId = requestIdParam(c.req.param('requestId'));
    const body = reviewContracts.decision.parse(await c.req.json());
    return c.json(
      await deps.review.retryDead({
        requestId,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        evidenceRefs: body.evidenceRefs,
        adminId: c.get('adminId'),
        operationId: operationId(c),
      }),
    );
  });

  app.post('/v1/billing-operations/:requestId/abandon', async (c) => {
    const requestId = requestIdParam(c.req.param('requestId'));
    const body = reviewContracts.decision.parse(await c.req.json());
    return c.json(
      await deps.review.abandonDead({
        requestId,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        evidenceRefs: body.evidenceRefs,
        adminId: c.get('adminId'),
        operationId: operationId(c),
      }),
    );
  });

  return app;
}
