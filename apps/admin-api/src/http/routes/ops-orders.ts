/**
 * 支付订单管理路由（P4;v1 routes/ops.ts payment-orders 族平移）：管理列表
 * + 手动关单（close 无请求体——admin 前端直调;关单理由装配注入零写死）。
 * 关单失败（已付/已入账/已关/不存在）经 billing 目录 order_state_conflict
 * 渲染 409（v1 conflict 语义）。
 */
import { Hono } from 'hono';
import type { PaymentAdminApi } from '@tokenlens/billing';
import type { SessionEnv } from '../middleware/session';
import { listEnvelope, parseListQuery } from '../contracts/common';
import { ORDER_SORTS, requestIdParam } from '../contracts/billing-admin';
import { toOrderWireRow } from '../presenters/ops';

export interface OpsOrdersRoutesDeps {
  readonly paymentAdmin: PaymentAdminApi;
  /** 手动关单的 failureReason 留痕文案（审计数据,装配层显式持有——铁律 3） */
  readonly orderCloseReason: string;
}

export function opsOrdersRoutes(deps: OpsOrdersRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/payment-orders', async (c) => {
    const query = parseListQuery(c.req.query(), ORDER_SORTS, 'createdAt');
    const result = await deps.paymentAdmin.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'amount' | 'status' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toOrderWireRow), result.total, query));
  });

  app.post('/v1/payment-orders/:id/close', async (c) => {
    // uuid 形状守卫复用 billing 域参数面(同正则单一真相)
    const orderId = requestIdParam(c.req.param('id'));
    return c.json(await deps.paymentAdmin.close({ orderId, reason: deps.orderCloseReason }));
  });

  return app;
}
