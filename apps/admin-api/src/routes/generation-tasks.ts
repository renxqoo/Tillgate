import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { listGenerationTasks } from '../services/generation-tasks.js';

/**
 * 异步生成任务列表（管理端，api-contract §4.9）：video/music 任务生命周期 +
 * 失败原因 + 关联账单结算金额（运营对「任务卡死/失败退款」的观测入口）。
 */
const generationTasksQuerySchema = z.object({
  kind: z.enum(['video', 'music']).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function generationTaskAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', query(generationTasksQuerySchema), async (c) =>
    c.json(await listGenerationTasks(s, c.req.valid('query'))),
  );
}
