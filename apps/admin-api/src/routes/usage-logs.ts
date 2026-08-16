import { Hono } from 'hono';
import { query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { listUsageLogs, usageLogsQuerySchema } from '../services/usage-logs.js';

/**
 * 用量明细（管理端专属，api-contract §4.8 扩展）：每一笔扣款含估算标记。
 * estimated=1 过滤即「估算扣款观测入口」（2026-08-17 政策配套）。
 */
export function usageLogAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', query(usageLogsQuerySchema), async (c) =>
    c.json(await listUsageLogs(s, c.req.valid('query'))),
  );
}
