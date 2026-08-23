/**
 * 生成任务的 postgres 存储（generation_tasks 表；gateway P5 波 C-G9——表已在
 * db migration 0053/0054 落库，本适配器实现本包 GenerationTaskStore port 的
 * 生产形态，与 createRedisHealthStore 同为根出口装配件）。
 *
 * 入队面只写 insert；状态机 UPDATE（running/终态/过期）全部在下方推进动词族
 * （application/generation-poll.ts 消费，worker app 驱动）——单一写口径。
 * 权威时间源 = 库端 clock_timestamp()（expireOverdue 的超时判定不读应用时钟）。
 */
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@tokenlens/db';
import { billingRequests, generationTasks, usageLogs } from '@tokenlens/db';
import type { GenerationTaskKind } from '../domain/generation';
import type {
  GenerationTaskActiveRow,
  GenerationTaskAdminRow,
  GenerationTaskRecord,
  GenerationTaskStore,
  GenerationTaskView,
} from '../ports/generation';
import { GENERATION_TASK_STATUSES } from '../ports/generation';

/** 视图状态词表（DB check 约束同源;port GENERATION_TASK_STATUSES 单一真相） */
const TASK_STATUSES = GENERATION_TASK_STATUSES;

export function createPostgresGenerationTaskStore(db: Db): GenerationTaskStore {
  return {
    async insert(record: GenerationTaskRecord): Promise<void> {
      // 列 NOT NULL：任务入库必属某次已命中的渠道尝试（port 类型的 null 态在用例
      // 层不可达；此处显式拒绝，避免把缺陷延迟到 PG 报模糊约束错）
      if (record.channelId == null) {
        throw new Error(`generation task ${record.taskId} has no channel hit`);
      }
      await db.insert(generationTasks).values({
        id: record.taskId,
        requestId: record.requestId,
        userId: record.userId,
        apiKeyId: record.apiKeyId,
        mappingId: record.mappingId,
        channelId: record.channelId,
        upstreamTaskId: record.upstreamTaskId,
        kind: record.kind,
        status: record.status,
        params: record.params,
        receiptTemplate: record.receiptTemplate as unknown as Record<string, unknown>,
        unitsSnapshot: String(record.unitsSnapshot),
        expiresAt: new Date(record.expiresAt),
      });
    },

    async findByOwner(userId, taskId): Promise<GenerationTaskView | null> {
      const rows = await db
        .select({
          taskId: generationTasks.id,
          userId: generationTasks.userId,
          kind: generationTasks.kind,
          status: generationTasks.status,
          upstreamTaskId: generationTasks.upstreamTaskId,
          params: generationTasks.params,
          result: generationTasks.result,
          failReason: generationTasks.failReason,
          createdAt: generationTasks.createdAt,
          expiresAt: generationTasks.expiresAt,
        })
        .from(generationTasks)
        .where(eq(generationTasks.id, taskId))
        .limit(1);
      const row = rows[0];
      // 属主隔离：非本人 = 不存在（404 语义，不泄漏任务存在性）
      if (row == null || row.userId !== userId) return null;
      const status = (TASK_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as GenerationTaskView['status'])
        : 'queued';
      return {
        taskId: row.taskId,
        kind: row.kind as GenerationTaskView['kind'],
        status,
        upstreamTaskId: row.upstreamTaskId,
        params: row.params,
        result: row.result,
        failReason: row.failReason,
        createdAt: row.createdAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
      };
    },

    /** 管理面全量列表（v1 listAdminTasks 平移）：kind/status 过滤 + 账单状态左联 */
    async adminList(input) {
      const conditions = [];
      if (input.kind) conditions.push(eq(generationTasks.kind, input.kind));
      if (input.status) conditions.push(eq(generationTasks.status, input.status));
      const where = conditions.length ? and(...conditions) : undefined;
      const [rows, countRows] = await Promise.all([
        db
          .select({
            taskId: generationTasks.id,
            requestId: generationTasks.requestId,
            kind: generationTasks.kind,
            status: generationTasks.status,
            userId: generationTasks.userId,
            channelId: generationTasks.channelId,
            upstreamTaskId: generationTasks.upstreamTaskId,
            failReason: generationTasks.failReason,
            result: generationTasks.result,
            billingStatus: billingRequests.status,
            createdAt: generationTasks.createdAt,
            finishedAt: generationTasks.finishedAt,
            expiresAt: generationTasks.expiresAt,
          })
          .from(generationTasks)
          .leftJoin(billingRequests, eq(billingRequests.requestId, generationTasks.requestId))
          .where(where)
          .orderBy(desc(generationTasks.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(generationTasks)
          .where(where),
      ]);
      return {
        rows: rows.map(
          (row): GenerationTaskAdminRow => ({
            taskId: row.taskId,
            requestId: row.requestId,
            kind: row.kind as GenerationTaskAdminRow['kind'],
            status: (TASK_STATUSES as readonly string[]).includes(row.status)
              ? (row.status as GenerationTaskAdminRow['status'])
              : 'queued',
            userId: row.userId,
            channelId: row.channelId,
            upstreamTaskId: row.upstreamTaskId,
            failReason: row.failReason,
            result: row.result ?? null,
            billingStatus: row.billingStatus ?? null,
            createdAt: row.createdAt.getTime(),
            finishedAt: row.finishedAt == null ? null : row.finishedAt.getTime(),
            expiresAt: row.expiresAt.getTime(),
          }),
        ),
        total: countRows[0]?.count ?? 0,
      };
    },

    /** 已结算任务实扣金额：任务行 → 账单锚 join usage_logs（页内批量） */
    async settledAmounts(taskIds) {
      if (taskIds.length === 0) return new Map<string, string>();
      const rows = await db
        .select({ taskId: generationTasks.id, amount: usageLogs.amount })
        .from(generationTasks)
        .innerJoin(usageLogs, eq(usageLogs.requestId, generationTasks.requestId))
        .where(inArray(generationTasks.id, [...taskIds]));
      return new Map(rows.map((r) => [r.taskId, r.amount]));
    },

    async expireOverdue(reason) {
      const rows = await db
        .update(generationTasks)
        .set({
          status: 'expired',
          failReason: reason,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            inArray(generationTasks.status, ['queued', 'running']),
            lte(generationTasks.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ taskId: generationTasks.id, requestId: generationTasks.requestId });
      return rows;
    },

    async listActive(input): Promise<GenerationTaskActiveRow[]> {
      const rows = await db
        .select({
          taskId: generationTasks.id,
          requestId: generationTasks.requestId,
          channelId: generationTasks.channelId,
          kind: generationTasks.kind,
          status: generationTasks.status,
          upstreamTaskId: generationTasks.upstreamTaskId,
          params: generationTasks.params,
          receiptTemplate: generationTasks.receiptTemplate,
          unitsSnapshot: generationTasks.unitsSnapshot,
          createdAt: generationTasks.createdAt,
          expiresAt: generationTasks.expiresAt,
        })
        .from(generationTasks)
        .where(
          and(
            inArray(generationTasks.kind, [...input.kinds]),
            inArray(generationTasks.status, [...input.statuses]),
            ...(input.afterCreatedAt != null
              ? [gt(generationTasks.createdAt, new Date(input.afterCreatedAt))]
              : []),
          ),
        )
        .orderBy(asc(generationTasks.createdAt))
        .limit(input.batch);
      return rows.map((row) => ({
        taskId: row.taskId,
        requestId: row.requestId,
        channelId: row.channelId,
        kind: row.kind as GenerationTaskKind,
        status: row.status === 'running' ? 'running' : 'queued',
        upstreamTaskId: row.upstreamTaskId,
        params: row.params,
        receiptTemplate:
          row.receiptTemplate as unknown as GenerationTaskActiveRow['receiptTemplate'],
        unitsSnapshot: Number(row.unitsSnapshot ?? '1'),
        createdAt: row.createdAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
      }));
    },

    async markRunning(taskId) {
      const rows = await db
        .update(generationTasks)
        .set({ status: 'running', updatedAt: sql`clock_timestamp()` })
        .where(and(eq(generationTasks.id, taskId), eq(generationTasks.status, 'queued')))
        .returning({ taskId: generationTasks.id });
      return rows.length > 0;
    },

    async casTerminal(input) {
      const rows = await db
        .update(generationTasks)
        .set({
          status: input.status,
          ...(input.status === 'succeeded'
            ? { result: input.result }
            : { failReason: input.failReason }),
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        // 非终态守卫：0 行 = 他副本已终态化（幂等静默）
        .where(
          and(
            eq(generationTasks.id, input.taskId),
            inArray(generationTasks.status, ['queued', 'running']),
          ),
        )
        .returning({ taskId: generationTasks.id });
      return rows.length > 0;
    },
  };
}
