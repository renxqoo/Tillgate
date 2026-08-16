import { Hono } from 'hono';
import { listQuerySchema, query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { listAuditLogs, listRequestLogs, logsQuerySchema } from '../services/logs.js';

/**
 * 日志查询（api-contract §4.8）。
 *
 *   - GET /api/admin/logs：请求日志（默认 30 天滚动，附 userName）
 *   - GET /api/admin/audit-logs：管理操作审计
 * 查询与过滤在 services/logs.ts；此处只做入参校验与响应。
 */

/** 请求日志（挂载于 /api/admin/logs） */
export function logAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', query(logsQuerySchema), async (c) =>
    c.json(await listRequestLogs(s, c.req.valid('query'))),
  );
}

/** 管理操作审计（挂载于 /api/admin/audit-logs） */
export function auditLogAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', query(listQuerySchema), async (c) =>
    c.json(await listAuditLogs(s, c.req.valid('query'))),
  );
}
