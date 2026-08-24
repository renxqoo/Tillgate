/**
 * 套餐路由（P1;v1 routes/plans.ts 平移）：列表/创建/补丁（kind 不可变——
 * strictObject 拒未知键）/删除（含历史订阅引用守卫 409 billing.plan_in_use）。
 * plans 域审计后置（v1 recordAudit 同为提交后旁路——writeAudit 装配闭包）。
 */
import { Hono } from 'hono';
import type { PlansApi } from '@tokenlens/billing';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { PLAN_SORTS, plansContracts } from '../contracts/billing-admin';
import { toPlanWireRow } from '../presenters/billing';
import type { SessionEnv } from '../middleware/session';
import type { PostAudit } from './redeem';

export interface PlansRoutesDeps {
  readonly plans: PlansApi;
  /** 后置审计闭包（v1 recordAudit 语义——提交后旁路,失败不阻断） */
  readonly postAudit: PostAudit;
}

export function plansRoutes(deps: PlansRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/plans', async (c) => {
    const query = parseListQuery(c.req.query(), PLAN_SORTS, 'id');
    const page = await deps.plans.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'name' | 'status' | 'price' | 'sortOrder',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows.map(toPlanWireRow), page.total, query));
  });

  app.post('/v1/plans', async (c) => {
    const body = plansContracts.create.parse(await c.req.json());
    const row = await deps.plans.create({
      name: body.name,
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      price: body.price,
      ...(body.periodDays !== undefined ? { periodDays: body.periodDays } : {}),
      quotaAmount: body.quotaAmount,
      ...(body.allowSeats !== undefined ? { allowSeats: body.allowSeats } : {}),
    });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'plan.create',
      targetType: 'plan',
      targetId: row.id,
      detail: { name: row.name, kind: row.kind, price: row.price, quotaAmount: row.quotaAmount },
    });
    return c.json(toPlanWireRow(row), 201);
  });

  app.patch('/v1/plans/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = plansContracts.update.parse(await c.req.json());
    const row = await deps.plans.update({ planId: id, patch: body });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'plan.update',
      targetType: 'plan',
      targetId: row.id,
      detail: { patch: body },
    });
    return c.json(toPlanWireRow(row));
  });

  app.delete('/v1/plans/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const result = await deps.plans.remove({ planId: id });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'plan.delete',
      targetType: 'plan',
      targetId: id,
      detail: null,
    });
    return c.json(result);
  });

  return app;
}
