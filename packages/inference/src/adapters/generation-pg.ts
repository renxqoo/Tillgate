/**
 * 生成任务的 postgres 存储（generation_tasks 表——表已在
 * db migration 0053/0054 落库，本适配器实现本包 GenerationTaskStore port 的
 * 生产形态，与 createRedisHealthStore 同为根出口装配件）。
 *
 * 入队面只写 insert；状态机 UPDATE（running/终态/过期）全部在下方推进动词族
 * （application/generation-poll.ts 消费，worker app 驱动）——单一写口径。
 * 权威时间源 = 库端 clock_timestamp()（expireOverdue 的超时判定不读应用时钟）。
 */
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@tillgate/db';
import { billingRequests, generationTasks, usageLogs } from '@tillgate/db';
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

/** 状态列收敛:库端脏值兜底 queued(与词表同源的封闭收敛) */
function statusOf(raw: string): 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' {
  return (TASK_STATUSES as readonly string[]).includes(raw)
    ? (raw as GenerationTaskView['status'])
    : 'queued';
}

/** 入队:任务行落库(必属某次已命中的渠道尝试) */
async function insertGenerationTask(db: Db, record: GenerationTaskRecord): Promise<void> {
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
}

/** 属主读:非本人 = 不存在(404 语义,不泄漏任务存在性) */
async function findTaskByOwner(
  db: Db,
  userId: number,
  taskId: string,
): Promise<GenerationTaskView | null> {
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
  const [row] = rows;
  if (row == null || row.userId !== userId) return null;
  return {
    taskId: row.taskId,
    kind: row.kind as GenerationTaskView['kind'],
    status: statusOf(row.status),
    upstreamTaskId: row.upstreamTaskId,
    params: row.params,
    result: row.result,
    failReason: row.failReason,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

/** 管理行映射:账单状态左联(null = 无关联请求) */
function mapAdminRow(row: {
  taskId: string;
  requestId: string;
  kind: string;
  status: string;
  userId: number;
  channelId: number;
  upstreamTaskId: string | null;
  failReason: string | null;
  result: Record<string, unknown> | null;
  billingStatus: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
}): GenerationTaskAdminRow {
  return {
    taskId: row.taskId,
    requestId: row.requestId,
    kind: row.kind as GenerationTaskAdminRow['kind'],
    status: statusOf(row.status),
    userId: row.userId,
    channelId: row.channelId,
    upstreamTaskId: row.upstreamTaskId,
    failReason: row.failReason,
    result: row.result ?? null,
    billingStatus: row.billingStatus ?? null,
    createdAt: row.createdAt.getTime(),
    finishedAt: row.finishedAt == null ? null : row.finishedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

/** 管理面全量列表：kind/status 过滤 + 账单状态左联 */
async function adminListTasks(
  db: Db,
  input: Parameters<GenerationTaskStore['adminList']>[0],
): Promise<Awaited<ReturnType<GenerationTaskStore['adminList']>>> {
  const conditions = [];
  if (input.kind) conditions.push(eq(generationTasks.kind, input.kind));
  if (input.status) conditions.push(eq(generationTasks.status, input.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
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
    rows: rows.map(mapAdminRow),
    total: countRows[0]?.count ?? 0,
  };
}

/** 已结算任务实扣金额：任务行 → 账单锚 join usage_logs（页内批量） */
async function settledAmountsOf(db: Db, taskIds: readonly string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ taskId: generationTasks.id, amount: usageLogs.amount })
    .from(generationTasks)
    .innerJoin(usageLogs, eq(usageLogs.requestId, generationTasks.requestId))
    .where(inArray(generationTasks.id, [...taskIds]));
  return new Map(rows.map((r) => [r.taskId, r.amount]));
}

/** 过期批推进:非终态且已过 expiresAt 的行收敛 expired(时钟取库端) */
async function expireOverdueTasks(
  db: Db,
  reason: string,
): Promise<Array<{ taskId: string; requestId: string }>> {
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
}

/** 活跃行映射(worker 拉取面:receiptTemplate/unitsSnapshot 透传) */
function mapActiveRow(row: {
  taskId: string;
  requestId: string;
  channelId: number;
  kind: string;
  status: string;
  upstreamTaskId: string | null;
  params: Record<string, unknown>;
  receiptTemplate: unknown;
  unitsSnapshot: string | null;
  createdAt: Date;
  expiresAt: Date;
}): GenerationTaskActiveRow {
  return {
    taskId: row.taskId,
    requestId: row.requestId,
    channelId: row.channelId,
    kind: row.kind as GenerationTaskKind,
    status: row.status === 'running' ? 'running' : 'queued',
    upstreamTaskId: row.upstreamTaskId,
    params: row.params,
    receiptTemplate: row.receiptTemplate as unknown as GenerationTaskActiveRow['receiptTemplate'],
    unitsSnapshot: Number(row.unitsSnapshot ?? '1'),
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

/** 活跃批拉取(worker 消费面):kind/status 过滤 + 游标 + 有界批量 */
async function listActiveTasks(
  db: Db,
  input: Parameters<GenerationTaskStore['listActive']>[0],
): Promise<GenerationTaskActiveRow[]> {
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
  return rows.map(mapActiveRow);
}

/** queued → running CAS(多副本单赢家) */
async function markTaskRunning(db: Db, taskId: string): Promise<boolean> {
  const rows = await db
    .update(generationTasks)
    .set({ status: 'running', updatedAt: sql`clock_timestamp()` })
    .where(and(eq(generationTasks.id, taskId), eq(generationTasks.status, 'queued')))
    .returning({ taskId: generationTasks.id });
  return rows.length > 0;
}

/** 终态 CAS:非终态守卫,0 行 = 他副本已终态化(幂等静默) */
async function casTaskTerminal(
  db: Db,
  input: Parameters<GenerationTaskStore['casTerminal']>[0],
): Promise<boolean> {
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
    .where(
      and(
        eq(generationTasks.id, input.taskId),
        inArray(generationTasks.status, ['queued', 'running']),
      ),
    )
    .returning({ taskId: generationTasks.id });
  return rows.length > 0;
}

export function createPostgresGenerationTaskStore(db: Db): GenerationTaskStore {
  return {
    insert: (record) => insertGenerationTask(db, record),
    findByOwner: (userId, taskId) => findTaskByOwner(db, userId, taskId),
    adminList: (input) => adminListTasks(db, input),
    settledAmounts: (taskIds) => settledAmountsOf(db, taskIds),
    expireOverdue: (reason) => expireOverdueTasks(db, reason),
    listActive: (input) => listActiveTasks(db, input),
    markRunning: (taskId) => markTaskRunning(db, taskId),
    casTerminal: (input) => casTaskTerminal(db, input),
  };
}
