import type { Db } from '@tillgate/db';
import { createPgAuditQueries } from './adapters/postgres/audit-store';
import { createPgRequestLogStore } from './adapters/postgres/request-log-store';
import {
  maintainRequestLogPartitions,
  type RequestLogPartitionOptions,
  type RequestLogPartitionResult,
} from './adapters/postgres/request-log-partitions';
import { createPgTraceStore } from './adapters/postgres/trace-store';
import { maintainTracePartitions } from './adapters/postgres/trace-partitions';
import { createPgUsageStore } from './adapters/postgres/usage-store';
import type { AuditQueries } from './audit/types';
import type { RequestLogStore } from './request-log/types';
import type { MaintainPartitionsOptions, MaintainPartitionsResult } from './tracing/partition';
import { createTraceQueries, type TraceQueries } from './tracing/queries';
import { createUsageQueries, type UsageQueries } from './usage/queries';

/**
 * createObservability facade(装配消费面 = apps 的 assembly:trace-receiver/gateway/
 * admin-api/worker)。职责:PG 适配器组装——查询面经 facet 直出,写入原语与纯函数
 * (decode/graph/ingest/telemetry)独立出口,按部署单元取用。
 *
 * 审计同事务写入(writeAudit)不在 facade 上——事务边界归发起业务用例的调用方;
 * facade 只持查询与旁路写入,不暴露 DbTx。
 */
export interface ObservabilityEnv {
  db: Db;
}

export interface Observability {
  /** trace 查询信封(recent/详情/点查/拓扑/统计) */
  traces: TraceQueries;
  /** 审计通用查询(全局列表/定向下钻);价格溯源等 action 语义查询归能力包 */
  audit: AuditQueries;
  /** 请求日志写入与列表 */
  requestLogs: RequestLogStore;
  /** usage_logs 运维读侧(管理列表/概览/分组/趋势/渠道 TTFT;admin-api 消费) */
  usage: UsageQueries;
  /** 分区维护(worker 定时调用;内置 advisory try-lock,未获锁 = 跳过) */
  partitions: {
    traces(options?: MaintainPartitionsOptions): Promise<MaintainPartitionsResult>;
    requestLogs(options: RequestLogPartitionOptions): Promise<RequestLogPartitionResult>;
  };
}

export function createObservability(env: ObservabilityEnv): Observability {
  const { db } = env;
  const traceStore = createPgTraceStore(db);
  const requestLogs = createPgRequestLogStore(db);
  return {
    traces: createTraceQueries(traceStore),
    audit: createPgAuditQueries(db),
    requestLogs,
    usage: createUsageQueries({ store: createPgUsageStore(db) }),
    partitions: {
      traces: (options) => maintainTracePartitions(db, options),
      requestLogs: (options) => maintainRequestLogPartitions(db, options),
    },
  };
}
