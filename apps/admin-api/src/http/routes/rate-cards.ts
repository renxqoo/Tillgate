/**
 * 费率卡路由：列表/创建/更新/删除（绑定守卫）/
 * 卡内用户/健康自检。系数 0.001..9.999,落库与回显恒 3 位小数（control-plane）。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tillgate/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { RATE_CARD_SORTS, RATE_CARD_USER_SORTS, rateCardsContracts } from '../contracts/rates';
import { toRateCardWireRow } from '../presenters/rates';

export interface RateCardsRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'rates'>;
}

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为既有语义
export function rateCardsRoutes(deps: RateCardsRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const { rates } = deps.controlPlane;

  app.get('/v1/rate-cards', async (c) => {
    const query = parseListQuery(c.req.query(), RATE_CARD_SORTS, 'createdAt');
    const result = await rates.listCards({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'name' | 'status' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toRateCardWireRow), result.total, query));
  });

  app.post('/v1/rate-cards', async (c) => {
    const body = rateCardsContracts.create.parse(await c.req.json());
    const row = await rates.createCard({ ctx: controlContextOf(c), ...body });
    return c.json(row, 201);
  });

  app.patch('/v1/rate-cards/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = rateCardsContracts.update.parse(await c.req.json());
    return c.json(await rates.updateCard({ ctx: controlContextOf(c), rateCardId: id, patch }));
  });

  app.delete('/v1/rate-cards/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await rates.deleteCard({ ctx: controlContextOf(c), rateCardId: id }));
  });

  app.get('/v1/rate-cards/:id/users', async (c) => {
    const id = idParam(c.req.param('id'));
    const query = parseListQuery(c.req.query(), RATE_CARD_USER_SORTS, 'id');
    const result = await rates.listCardUsers({
      rateCardId: id,
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'subject' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows, result.total, query));
  });

  app.get('/v1/rate-cards/:id/health', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await rates.cardHealth(id));
  });

  return app;
}
