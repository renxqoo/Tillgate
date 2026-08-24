/**
 * 兑换批次路由（P1;v1 routes/redeem.ts 平移）：创建（明文码仅此一次返回）/
 * 列表 / 详情 / 批内码列表（哈希脱敏）/ 单码作废。
 * 审计后置（v1 recordAudit 语义——提交后旁路）。
 */
import { Hono } from 'hono';
import type { RedeemBatchesApi } from '@tillgate/billing';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { BATCH_SORTS, CODE_SORTS, redeemContracts } from '../contracts/billing-admin';
import { toBatchWireRow, toCodeWireRow } from '../presenters/billing';
import type { SessionEnv } from '../middleware/session';

/** 后置审计闭包形状（v1 recordAudit:提交后旁路、失败不阻断——装配桥 writeAudit） */
export interface PostAudit {
  (entry: {
    actor: 'admin';
    adminId: number;
    action: string;
    targetType: string;
    targetId: string | number;
    detail: Record<string, unknown> | null;
  }): Promise<void>;
}

export interface RedeemRoutesDeps {
  readonly redeemBatches: RedeemBatchesApi;
  readonly postAudit: PostAudit;
}

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为 v1 平移语义(存量棘轮)
export function redeemRoutes(deps: RedeemRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/redeem-batches', async (c) => {
    const body = redeemContracts.create.parse(await c.req.json());
    const result = await deps.redeemBatches.create({
      createdBy: c.get('adminId'),
      name: body.name,
      ...(body.remark !== undefined ? { remark: body.remark } : {}),
      amount: body.amount,
      count: body.count,
      ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
    });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'redeem_batch.create',
      targetType: 'redeem_batch',
      targetId: result.batch.id,
      detail: { name: body.name, amount: body.amount, count: body.count },
    });
    return c.json(
      { batch: { ...result.batch, amount: result.batch.amount }, codes: result.codes },
      201,
    );
  });

  app.get('/v1/redeem-batches', async (c) => {
    const query = parseListQuery(c.req.query(), BATCH_SORTS, 'createdAt');
    const page = await deps.redeemBatches.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'name' | 'amount' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows.map(toBatchWireRow), page.total, query));
  });

  app.get('/v1/redeem-batches/:id', async (c) => {
    const row = await deps.redeemBatches.detail(idParam(c.req.param('id')));
    return c.json(toBatchWireRow(row));
  });

  app.get('/v1/redeem-batches/:id/codes', async (c) => {
    const id = idParam(c.req.param('id'));
    const extra = redeemContracts.codesQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), CODE_SORTS, 'id');
    const page = await deps.redeemBatches.codes({
      batchId: id,
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      sortBy: query.sortBy as 'id' | 'usedAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows.map(toCodeWireRow), page.total, query));
  });

  app.post('/v1/redeem-batches/codes/:codeId/revoke', async (c) => {
    const codeId = idParam(c.req.param('codeId'));
    const result = await deps.redeemBatches.revoke({ codeId });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'redeem_code.revoke',
      targetType: 'redeem_code',
      targetId: codeId,
      detail: null,
    });
    return c.json(result);
  });

  return app;
}
