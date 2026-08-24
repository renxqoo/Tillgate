/**
 * 模型映射路由（v1 routes/models.ts 平移 + 逻辑删除回收站）：
 * 列表（channelIds 回显 / view=deleted 回收站）/创建/更新（含上下架 status）/
 * 逻辑删除/恢复记录/绑定全量替换/逐渠道探针。价格仅精确十进制字符串。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlane } from '@tokenlens/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { MODEL_SORTS, modelsContracts } from '../contracts/models';
import { toModelWireRow } from '../presenters/models';

export interface ModelsRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'models'>;
}

export function modelsRoutes(
  deps: ModelsRoutesDeps,
  guard: (code: string) => MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();
  const models = deps.controlPlane.models;

  app.get('/v1/models', guard('catalog:read'), async (c) => {
    const query = parseListQuery(c.req.query(), MODEL_SORTS, 'createdAt');
    // 回收站视图：仅认 'deleted'，其余值容错回退默认在册视图（列表参数永不 400）
    const view = c.req.query('view') === 'deleted' ? ('deleted' as const) : undefined;
    const result = await models.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'externalName' | 'realModel' | 'status' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
      ...(view !== undefined ? { view } : {}),
    });
    const rows = result.rows.map((row) =>
      toModelWireRow(row, (row as { channelIds?: number[] }).channelIds ?? []),
    );
    return c.json(listEnvelope(rows, result.total, query));
  });

  app.post('/v1/models', guard('catalog:create'), async (c) => {
    const body = modelsContracts.create.parse(await c.req.json());
    const row = await models.create({
      ctx: controlContextOf(c),
      externalName: body.externalName,
      realModel: body.realModel,
      ...(body.contextLength !== undefined ? { contextLength: body.contextLength } : {}),
      prices: {
        inputPrice: body.inputPrice,
        outputPrice: body.outputPrice,
        cacheInputPrice: body.cacheInputPrice,
        cacheWritePrice: body.cacheWritePrice ?? '0',
        unitPrice: body.unitPrice ?? '0',
      },
      pricingUnit: body.pricingUnit,
      ...(body.billingConfig !== undefined ? { billingConfig: body.billingConfig } : {}),
      ...(body.isFree !== undefined ? { isFree: body.isFree } : {}),
      rpmLimit: body.rpmLimit ?? null,
      tpmLimit: body.tpmLimit ?? null,
      billingPolicy: body.billingPolicy ?? null,
    });
    return c.json(toModelWireRow(row), 201);
  });

  app.patch('/v1/models/:id', guard('catalog:update'), async (c) => {
    const id = idParam(c.req.param('id'));
    const body = modelsContracts.update.parse(await c.req.json());
    const priceSet =
      body.inputPrice !== undefined ||
      body.outputPrice !== undefined ||
      body.cacheInputPrice !== undefined ||
      body.cacheWritePrice !== undefined ||
      body.unitPrice !== undefined;
    const row = await models.update({
      ctx: controlContextOf(c),
      mappingId: id,
      patch: {
        ...(body.externalName !== undefined ? { externalName: body.externalName } : {}),
        ...(body.realModel !== undefined ? { realModel: body.realModel } : {}),
        ...(body.contextLength !== undefined ? { contextLength: body.contextLength } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.isFree !== undefined ? { isFree: body.isFree } : {}),
        ...(body.billingPolicy !== undefined ? { billingPolicy: body.billingPolicy } : {}),
        ...(body.rpmLimit !== undefined ? { rpmLimit: body.rpmLimit } : {}),
        ...(body.tpmLimit !== undefined ? { tpmLimit: body.tpmLimit } : {}),
        ...(body.pricingUnit !== undefined ? { pricingUnit: body.pricingUnit } : {}),
        ...(body.billingConfig !== undefined ? { billingConfig: body.billingConfig ?? {} } : {}),
        ...(priceSet
          ? {
              prices: {
                ...(body.inputPrice !== undefined ? { inputPrice: body.inputPrice } : {}),
                ...(body.outputPrice !== undefined ? { outputPrice: body.outputPrice } : {}),
                ...(body.cacheInputPrice !== undefined
                  ? { cacheInputPrice: body.cacheInputPrice }
                  : {}),
                ...(body.cacheWritePrice !== undefined
                  ? { cacheWritePrice: body.cacheWritePrice }
                  : {}),
                ...(body.unitPrice !== undefined ? { unitPrice: body.unitPrice } : {}),
              },
            }
          : {}),
      },
    });
    return c.json(toModelWireRow(row));
  });

  app.delete('/v1/models/:id', guard('catalog:delete'), async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await models.delete({ ctx: controlContextOf(c), mappingId: id }));
  });

  /** 恢复已删除记录（回收站取出，回下架态）；在册行调用 → 404 */
  app.post('/v1/models/:id/restore', guard('catalog:restore'), async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await models.undelete({ ctx: controlContextOf(c), mappingId: id }));
  });

  app.post('/v1/models/:id/channels', guard('catalog:bind'), async (c) => {
    const id = idParam(c.req.param('id'));
    const body = modelsContracts.bind.parse(await c.req.json());
    const result = await models.bindChannels({
      ctx: controlContextOf(c),
      mappingId: id,
      channels: body.channels,
    });
    return c.json({ ok: true, bound: result.bound });
  });

  app.post('/v1/models/:id/test', guard('catalog:test'), async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await models.probe(id));
  });

  return app;
}
