/**
 * ./composition 子入口(内部 workspace 契约,非公开 API):
 * 仅供 apps 的 assembly.ts、迁移脚本与 adapter 集成测试引用——跨能力审计桥
 * (capability AuditPort → 本包写入原语)与 app 细粒度装配(trace-receiver 直组
 * store+batcher)在此取件。业务调用方不得引用;架构测试锁定引用者白名单。
 */
export { createPgTraceStore } from './adapters/postgres/trace-store';
export {
  ensureTracePartition,
  listTracePartitionDays,
  maintainTracePartitions,
} from './adapters/postgres/trace-partitions';
export {
  writeAudit,
  createBestEffortAuditSink,
  createPgAuditQueries,
  type BestEffortAuditSink,
} from './adapters/postgres/audit-store';
export { createPgRequestLogStore } from './adapters/postgres/request-log-store';
export {
  maintainRequestLogPartitions,
  type RequestLogPartitionOptions,
  type RequestLogPartitionResult,
} from './adapters/postgres/request-log-partitions';
