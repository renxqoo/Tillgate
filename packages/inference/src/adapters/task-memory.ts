import type {
  GenerationTaskActiveRow,
  GenerationTaskAdminRow,
  GenerationTaskRecord,
  GenerationTaskStore,
  GenerationTaskView,
} from '../ports/generation';

/**
 * 内存任务存储（单副本开发/测试形态；生产为 postgres 适配器（由 worker 装配））。
 * 属主隔离在 findByOwner 强制（非本人 = 不存在）；推进动词族与 postgres 适配器
 * 同语义（超时/终态判定经注入的 now 时钟）。
 * adminList/settledAmounts 的账本投影（billingStatus/settledAmount）在内存形态
 * 无 billing/usage 数据源——billingStatus 恒 null、实扣金额恒空 Map（数据面缺席
 * 而非逻辑缺席;账单联读语义由 postgres 适配器与 real 测试承担）。
 */
interface TaskRow extends Omit<GenerationTaskRecord, 'status'> {
  status: GenerationTaskView['status'];
  result: unknown;
  failReason: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** 活跃行视图（推进动词族的读侧形状；模块级纯函数——不捕获闭包） */
function activeOf(row: TaskRow): GenerationTaskActiveRow {
  return {
    taskId: row.taskId,
    requestId: row.requestId,
    channelId: row.channelId ?? 0,
    kind: row.kind,
    status: row.status === 'running' ? 'running' : 'queued',
    upstreamTaskId: row.upstreamTaskId,
    params: row.params,
    receiptTemplate: row.receiptTemplate,
    unitsSnapshot: row.unitsSnapshot,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** 管理面过滤谓词(kind/status 缺省不过滤;行集与 total 共用同一真相) */
function adminFilterOf(
  input: Parameters<GenerationTaskStore['adminList']>[0],
): (row: TaskRow) => boolean {
  return (row) =>
    (input.kind === undefined || row.kind === input.kind) &&
    (input.status === undefined || row.status === input.status);
}

/** 管理面列表:过滤 + 建序倒排 + 分页(内存形态无账本投影,见文件头注记) */
async function adminListRows(
  rows: Map<string, TaskRow>,
  input: Parameters<GenerationTaskStore['adminList']>[0],
): Promise<{ rows: GenerationTaskAdminRow[]; total: number }> {
  const filter = adminFilterOf(input);
  const matched = [...rows.values()]
    .filter(filter)
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(input.offset, input.offset + input.limit);
  const total = [...rows.values()].filter(filter).length;
  const projected: GenerationTaskAdminRow[] = matched.map((row) => ({
    taskId: row.taskId,
    requestId: row.requestId,
    kind: row.kind,
    status: row.status,
    userId: row.userId,
    channelId: row.channelId ?? 0,
    upstreamTaskId: row.upstreamTaskId,
    failReason: row.failReason,
    result: (row.result as Record<string, unknown> | null) ?? null,
    // 内存形态无账本投影(文件头注记)——管理列表的账单列恒空
    billingStatus: null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    expiresAt: row.expiresAt,
  }));
  return { rows: projected, total };
}

/** 过期批推进:非终态且已过 expiresAt 的行收敛 expired */
async function expireOverdueRows(
  rows: Map<string, TaskRow>,
  now: () => number,
  reason: string,
): Promise<Array<{ taskId: string; requestId: string }>> {
  const expired: Array<{ taskId: string; requestId: string }> = [];
  for (const row of rows.values()) {
    if ((row.status === 'queued' || row.status === 'running') && row.expiresAt <= now()) {
      row.status = 'expired';
      row.failReason = reason;
      row.finishedAt = now();
      expired.push({ taskId: row.taskId, requestId: row.requestId });
    }
  }
  return expired;
}

/** 入队:同 taskId 重复入队响亮失败 */
async function insertRow(
  rows: Map<string, TaskRow>,
  now: () => number,
  record: GenerationTaskRecord,
): Promise<void> {
  if (rows.has(record.taskId)) {
    throw new Error(`duplicate generation task id: ${record.taskId}`);
  }
  rows.set(record.taskId, {
    ...record,
    status: record.status,
    result: null,
    failReason: null,
    createdAt: now(),
    finishedAt: null,
  });
}

/** 属主读:非本人 = 不存在(不泄漏存在性) */
async function findRowByOwner(
  rows: Map<string, TaskRow>,
  userId: number,
  taskId: string,
): Promise<GenerationTaskView | null> {
  const row = rows.get(taskId);
  if (row == null || row.userId !== userId) return null;
  const { status, result, failReason, createdAt, expiresAt, kind, params } = row;
  return {
    taskId: row.taskId,
    kind,
    status,
    upstreamTaskId: row.upstreamTaskId,
    params,
    result,
    failReason,
    createdAt,
    expiresAt,
  };
}

/** 活跃批拉取(worker 消费面):kind/status 过滤 + 游标 + 有界批量 */
async function listActiveRows(
  rows: Map<string, TaskRow>,
  input: Parameters<GenerationTaskStore['listActive']>[0],
): Promise<GenerationTaskActiveRow[]> {
  const matched = [...rows.values()]
    .filter(
      (row): row is TaskRow & { status: 'queued' | 'running' } =>
        (input.kinds as readonly string[]).includes(row.kind) &&
        (input.statuses as readonly string[]).includes(row.status) &&
        (input.afterCreatedAt == null || row.createdAt > input.afterCreatedAt),
    )
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .slice(0, input.batch);
  return matched.map(activeOf);
}

/** 终态 CAS:非终态守卫(他副本已终态化 = 幂等静默) */
async function casRowTerminal(
  rows: Map<string, TaskRow>,
  now: () => number,
  input: Parameters<GenerationTaskStore['casTerminal']>[0],
): Promise<boolean> {
  const row = rows.get(input.taskId);
  if (row == null || (row.status !== 'queued' && row.status !== 'running')) return false;
  row.status = input.status;
  if (input.status === 'succeeded') row.result = input.result;
  else row.failReason = input.failReason;
  row.finishedAt = now();
  return true;
}

export function createMemoryGenerationTaskStore(now: () => number = Date.now): GenerationTaskStore {
  const rows = new Map<string, TaskRow>();

  return {
    insert: (record) => insertRow(rows, now, record),
    findByOwner: (userId, taskId) => findRowByOwner(rows, userId, taskId),
    adminList: (input) => adminListRows(rows, input),
    async settledAmounts(taskIds) {
      // 内存形态无 usage_logs 投影(文件头注记)——无命中,键集空
      void taskIds;
      return new Map<string, string>();
    },
    expireOverdue: (reason) => expireOverdueRows(rows, now, reason),
    listActive: (input) => listActiveRows(rows, input),
    async markRunning(taskId) {
      const row = rows.get(taskId);
      if (row == null || row.status !== 'queued') return false;
      row.status = 'running';
      return true;
    },
    casTerminal: (input) => casRowTerminal(rows, now, input),
  };
}
