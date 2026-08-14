import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

/**
 * 链路追踪查询（管理台只读）：
 *
 *   GET /recent          最近 traces（时间·服务·错误·时长·requestId 过滤）
 *   GET /traces/:id      单 trace 全部 span（瀑布图数据）
 *   GET /by-request/:id  按 request_id 关联（计费复核页「查链路」入口）
 *   GET /stats           接收/存储统计（分区列表、保留水位）
 */

const recentQuerySchema = z.object({
  service: z.string().max(64).optional(),
  errorsOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  minDurationMs: z.coerce.number().int().min(0).optional(),
  requestId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  beforeMs: z.coerce.number().int().positive().optional(),
});

export function tracingAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/recent', query(recentQuerySchema), async (c) => {
      const q = c.req.valid('query');
      return c.json({
        items: await s.tracingStore.findRecentTraces({
          service: q.service,
          errorsOnly: q.errorsOnly,
          minDurationMs: q.minDurationMs,
          requestId: q.requestId,
          limit: q.limit,
          beforeMs: q.beforeMs,
        }),
      });
    })
    .get('/traces/:traceId', async (c) => {
      const spans = await s.tracingStore.findByTraceId(c.req.param('traceId'));
      if (spans.length === 0) return c.json({ spans: [], services: [], durationMs: 0 });
      const start = Math.min(...spans.map((sp) => sp.startTime.getTime()));
      const end = Math.max(...spans.map((sp) => sp.endTime.getTime()));
      return c.json({
        spans,
        services: [...new Set(spans.map((sp) => sp.service))],
        startMs: start,
        durationMs: end - start,
      });
    })
    .get('/by-request/:requestId', async (c) => {
      const spans = await s.tracingStore.findByRequestId(c.req.param('requestId'));
      return c.json({ spans });
    })
    .get('/topology', async (c) => {
      const hours = Math.min(168, Math.max(1, Number(c.req.query('hours')) || 24));
      return c.json({ hours, channels: await s.tracingStore.channelTopology(Date.now() - hours * 3_600_000) });
    })
    .get('/stats', async (c) => c.json({ storage: await s.tracingStore.stats() }));
}
