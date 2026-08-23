/**
 * 目录路由（v1 routes/catalog.ts 平移）：目录源清单/价格溯源/拉取比对/一键导入。
 * 导入价格必填（提交即确认——目录价只展示不自动带入;防 0 卖亏钱）。
 * /v1/vendor-catalog 为 P6 pending（vendor 档案词表待 ai 根出口,DESIGN §5 D1）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlane } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { catalogContracts, catalogSourceParam } from '../contracts/catalog';

export interface CatalogRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'catalog'>;
}

export function catalogRoutes(deps: CatalogRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();
  const catalog = deps.controlPlane.catalog;

  app.get('/v1/model-catalog/sources', session, (c) => c.json({ sources: catalog.listSources() }));

  /** 价格溯源：注册在 :sourceId 之前——否则字面段被参数路由吞掉（v1 同序）。 */
  app.get('/v1/model-catalog/price-history', session, async (c) => {
    const externalName = c.req.query('externalName');
    if (externalName === undefined || externalName === '' || externalName.length > 64) {
      throw AdminErrors.business('invalid_param', {
        field: 'externalName',
        reason: 'required (max 64 characters)',
      });
    }
    return c.json({ entries: await catalog.priceHistory({ externalName }) });
  });

  app.get('/v1/model-catalog/:sourceId', session, async (c) => {
    const sourceId = catalogSourceParam(c.req.param('sourceId'));
    return c.json(await catalog.comparison(sourceId));
  });

  app.post('/v1/model-catalog/import', session, async (c) => {
    const body = catalogContracts.import.parse(await c.req.json());
    return c.json(
      await catalog.import({
        ctx: controlContextOf(c),
        sourceId: body.sourceId,
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
        models: body.models.map((m) => ({
          externalName: m.externalName,
          realModel: m.realModel,
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cacheInputPrice: m.cacheInputPrice,
          cacheWritePrice: m.cacheWritePrice,
          contextLength: m.contextLength ?? null,
        })),
      }),
    );
  });

  return app;
}
