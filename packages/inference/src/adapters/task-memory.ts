import type {
  GenerationTaskRecord,
  GenerationTaskStore,
  GenerationTaskView,
} from '../ports/generation';

/**
 * 内存任务存储（单副本开发/测试形态；生产为 postgres 适配器——worker 波次装配）。
 * 属主隔离在 findByOwner 强制（非本人 = 不存在）。
 */
interface TaskRow extends Omit<GenerationTaskRecord, 'status'> {
  status: GenerationTaskView['status'];
  result: unknown;
  failReason: string | null;
  createdAt: number;
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
  };
}
