/**
 * 用量与统计路由（P4;v1 routes/ops.ts usage-logs/stats 族平移）：
 * 用量明细 / 概览 / 分组聚合 / 按日趋势 / 渠道首字延迟。
 * 语义全部经 observability.usage facet（SQL 在包 adapter;北京日界口径在包内）。
 * hours 收口逐字随迁 v1（Math.min/max + NaN→24,不走 zod 400——容错语义）。
 */
import { Hono } from 'hono';
import type { Observability } from '@tillgate/observability';
import type { SessionEnv } from '../middleware/session';
import { listEnvelope, parseListQuery } from '../contracts/common';
import { USAGE_SORTS, statsContracts, usageContracts } from '../contracts/observability';
import { toUsageWireRow } from '../presenters/ops';

export interface OpsUsageRoutesDeps {
  readonly observability: Pick<Observability, 'usage'>;
  /** 时钟注入（「今日」北京日界与 TTFT 窗口;测试可冻结） */
  readonly now: () => Date;
}

export function opsUsageRoutes(deps: OpsUsageRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const usage = deps.observability.usage;

  app.get('/v1/usage-logs', async (c) => {
    const extra = usageContracts.queryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), USAGE_SORTS, 'createdAt');
    const result = await usage.adminList({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(extra.from !== undefined ? { from: new Date(extra.from) } : {}),
      ...(extra.to !== undefined ? { to: new Date(extra.to) } : {}),
      ...(extra.userId !== undefined ? { userId: extra.userId } : {}),
      ...(extra.model !== undefined ? { model: extra.model } : {}),
      ...(extra.estimated !== undefined ? { estimated: extra.estimated } : {}),
      sortBy: query.sortBy as
        | 'id'
        | 'amount'
        | 'inputTokens'
        | 'outputTokens'
        | 'durationMs'
        | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toUsageWireRow), result.total, query));
  });

  app.get('/v1/stats/overview', async (c) => c.json(await usage.overview({ now: deps.now() })));

  app.get('/v1/stats/usage', async (c) => {
    const query = statsContracts.usage.parse(c.req.query());
    return c.json(
      await usage.groups({
        group: query.group,
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      }),
    );
  });

  app.get('/v1/stats/trends', async (c) => {
    const query = statsContracts.trends.parse(c.req.query());
    return c.json(await usage.trends({ days: query.days, now: deps.now() }));
  });

  app.get('/v1/analytics/channel-ttft', async (c) => {
    // v1 容错收口:非数/缺省 → 24,越界钳到 [1, 720](不 400)
    const hours = Math.min(720, Math.max(1, Number(c.req.query('hours')) || 24));
    return c.json(await usage.channelTtft({ hours, now: deps.now() }));
  });

  return app;
}
