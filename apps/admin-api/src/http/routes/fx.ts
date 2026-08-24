/**
 * 目录汇率路由（v1 routes/fx.ts 平移）：状态（含懒拉）/强制刷新/手动覆盖与清除/点差。
 * 全部动作留审计（fx.override / fx.override_clear / fx.buffer——control-plane）。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tillgate/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { fxCatalogContracts } from '../contracts/rates';

export interface FxRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'fx'>;
}

export function fxRoutes(deps: FxRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const fx = deps.controlPlane.fx;

  app.get('/v1/fx/catalog', async (c) => c.json(await fx.state()));

  app.post('/v1/fx/catalog/refresh', async (c) => {
    const body = fxCatalogContracts.refresh.parse(await c.req.json().catch(() => ({})));
    return c.json(await fx.refresh({ ctx: controlContextOf(c), force: body.force === true }));
  });

  app.put('/v1/fx/catalog/override', async (c) => {
    const body = fxCatalogContracts.override.parse(await c.req.json());
    return c.json(await fx.setOverride({ ctx: controlContextOf(c), rate: body.rate }));
  });

  app.delete('/v1/fx/catalog/override', async (c) =>
    c.json(await fx.clearOverride({ ctx: controlContextOf(c) })),
  );

  app.put('/v1/fx/catalog/buffer', async (c) => {
    const body = fxCatalogContracts.buffer.parse(await c.req.json());
    return c.json(await fx.setBuffer({ ctx: controlContextOf(c), bufferPct: body.bufferPct }));
  });

  return app;
}
