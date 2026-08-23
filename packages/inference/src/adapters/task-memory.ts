import type {
  GenerationTaskActiveRow,
  GenerationTaskAdminRow,
  GenerationTaskRecord,
  GenerationTaskStore,
  GenerationTaskView,
} from '../ports/generation';

/**
 * 内存任务存储（单副本开发/测试形态；生产为 postgres 适配器——worker 波次装配）。
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

export function createMemoryGenerationTaskStore(now: () => number = Date.now): GenerationTaskStore {
  const rows = new Map<string, TaskRow>();

  return {
    async insert(record: GenerationTaskRecord): Promise<void> {
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
    },
    async findByOwner(userId: number, taskId: string): Promise<GenerationTaskView | null> {
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
    },
    async adminList(input) {
      const matched = [...rows.values()]
        .filter(
          (row) =>
            (input.kind === undefined || row.kind === input.kind) &&
            (input.status === undefined || row.status === input.status),
        )
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .slice(input.offset, input.offset + input.limit);
      const total = [...rows.values()].filter(
        (row) =>
          (input.kind === undefined || row.kind === input.kind) &&
          (input.status === undefined || row.status === input.status),
      ).length;
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
    },
    async settledAmounts(taskIds) {
      // 内存形态无 usage_logs 投影(文件头注记)——无命中,键集空
      void taskIds;
      return new Map<string, string>();
    },
    async expireOverdue(reason) {
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
    },
    async listActive(input) {
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
    },
    async markRunning(taskId) {
      const row = rows.get(taskId);
      if (row == null || row.status !== 'queued') return false;
      row.status = 'running';
      return true;
    },
    async casTerminal(input) {
      const row = rows.get(input.taskId);
      if (row == null || (row.status !== 'queued' && row.status !== 'running')) return false;
      row.status = input.status;
      if (input.status === 'succeeded') row.result = input.result;
      else row.failReason = input.failReason;
      row.finishedAt = now();
      return true;
    },
  };
}
