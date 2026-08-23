/**
 * 分区维护 job（v1 tasks/partition-maintenance.ts 语义平移；DDL 与 advisory
 * try-lock 内建在 observability 适配器——天然多副本安全）。trace 日分区与
 * request_logs 月分区两个动作、同节奏（v1 两个独立循环共用一个 interval env）。
 */
interface PartitionJobResult {
  traces: { created: string[]; dropped: string[] };
  requestLogs: { created: string[]; dropped: string[] };
}

type PartitionJob = () => Promise<PartitionJobResult>;

export function createPartitionJob(deps: {
  partitions: {
    traces(options?: { retentionDays?: number }): Promise<{ created: string[]; dropped: string[] }>;
    requestLogs(options: {
      retentionDays: number;
    }): Promise<{ created: string[]; dropped: string[] }>;
  };
  traceRetentionDays: number;
  requestLogRetentionDays: number;
  logger: { info(obj: unknown, msg: string): void };
}): PartitionJob {
  return async function runPartitionMaintenance(): Promise<PartitionJobResult> {
    const traces = await deps.partitions.traces({ retentionDays: deps.traceRetentionDays });
    const requestLogs = await deps.partitions.requestLogs({
      retentionDays: deps.requestLogRetentionDays,
    });
    if (traces.created.length + traces.dropped.length > 0) {
      deps.logger.info({ ...traces }, 'trace partitions maintained');
    }
    if (requestLogs.created.length + requestLogs.dropped.length > 0) {
      deps.logger.info({ ...requestLogs }, 'request-log partitions maintained');
    }
    return { traces, requestLogs };
  };
}
