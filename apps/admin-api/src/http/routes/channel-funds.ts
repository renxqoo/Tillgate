/**
 * 渠道资金路由（v1 routes/channel-funds.ts 平移）：流水列表/进货（凭证 data URL
 * 内联）/调账。幂等键透传（同键同参重放、异参 409——control-plane operations）。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tillgate/control-plane';
import { normalizeAmount } from '@tillgate/billing';
import { operationId } from '@tillgate/http';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { listEnvelope, parseListQuery } from '../contracts/common';
import { CHANNEL_FUNDS_SORTS, channelFundsContracts } from '../contracts/control-plane';
import { toChannelFundWireRow } from '../presenters/control-plane';

export interface ChannelFundsRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'channels'>;
}

export function channelFundsRoutes(deps: ChannelFundsRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const channels = deps.controlPlane.channels;

  app.get('/v1/channel-funds', async (c) => {
    const extra = channelFundsContracts.listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), CHANNEL_FUNDS_SORTS, 'createdAt');
    const result = await channels.listRecharges({
      ...(extra.channelId !== undefined ? { channelId: extra.channelId } : {}),
      ...(extra.type !== undefined ? { type: extra.type } : {}),
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'amount' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toChannelFundWireRow), result.total, query));
  });

  app.post('/v1/channel-funds/recharge', async (c) => {
    const body = channelFundsContracts.recharge.parse(await c.req.json());
    const result = await channels.recharge({
      ctx: controlContextOf(c),
      channelId: body.channelId,
      amount: body.amount,
      orderNo: body.orderNo ?? null,
      voucherDataUrl: body.voucherDataUrl ?? null,
      remark: body.remark ?? null,
      operationId: operationId(c),
    });
    // numeric(38,18) 存储精度出站点归一(v1 wire 口径;e2e 抓出)
    return c.json({ ...result, balanceAfter: normalizeAmount(result.balanceAfter) });
  });

  app.post('/v1/channel-funds/adjust', async (c) => {
    const body = channelFundsContracts.adjust.parse(await c.req.json());
    const result = await channels.adjust({
      ctx: controlContextOf(c),
      channelId: body.channelId,
      amount: body.amount,
      remark: body.remark ?? null,
      operationId: operationId(c),
    });
    return c.json({ ...result, balanceAfter: normalizeAmount(result.balanceAfter) });
  });

  return app;
}
