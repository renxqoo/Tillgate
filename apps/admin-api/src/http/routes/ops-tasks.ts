/**
 * 生成任务管理路由（P4;v1 routes/ops.ts generation-tasks 平移）：全量列表
 * + 已结算任务实扣金额页内批量回填（task.id ≠ 计费锚——回填走 store 的
 * request_id join,路由只组合）。词表/过滤在 inference 包与 contracts 层。
 */
import { Hono } from 'hono';
import type { GenerationTaskStore } from '@tillgate/inference';
import type { SessionEnv } from '../middleware/session';
import { tasksContracts } from '../contracts/inference';
import { toTaskWireRow } from '../presenters/ops';

export interface OpsTasksRoutesDeps {
  readonly generationTasks: Pick<GenerationTaskStore, 'adminList' | 'settledAmounts'>;
}

export function opsTasksRoutes(deps: OpsTasksRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/generation-tasks', async (c) => {
    const query = tasksContracts.list.parse(c.req.query());
    const result = await deps.generationTasks.adminList({
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    // 已结算任务的实扣金额批量回填(v1 service 语义:settled 才查,页内批量消除 N+1)
    const settled = result.rows
      .filter((row) => row.billingStatus === 'settled')
      .map((row) => row.taskId);
    const amounts = await deps.generationTasks.settledAmounts(settled);
    return c.json({
      items: result.rows.map((row) => toTaskWireRow(row, amounts.get(row.taskId) ?? null)),
      total: result.total,
    });
  });

  return app;
}
