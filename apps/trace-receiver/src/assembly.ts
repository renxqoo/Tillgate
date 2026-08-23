import { createDb, type Db } from '@tokenlens/db';
import { createLogger, type Logger } from '@tokenlens/runtime';
import {
  initOtel,
  createSpanBatcher,
  type OtelHandle,
  type SpanBatcher,
  type TraceStore,
} from '@tokenlens/observability';
// ./composition 子入口仅 assembly 引用(§5.3):app 细粒度直组 store+batcher 的取件处
import { createPgTraceStore } from '@tokenlens/observability/composition';
import type { TraceReceiverConfig } from './config';

/**
 * 唯一依赖装配根:config → logger/otel/db/store/batcher。
 * 进程启动(index.ts)只调这里与 createReceiverApp,不自行拼装依赖。
 */

export interface ReceiverAssembly {
  readonly logger: Logger;
  readonly otel: OtelHandle;
  readonly db: Db;
  readonly store: TraceStore;
  readonly batcher: SpanBatcher;
}

export function assembleReceiver(config: TraceReceiverConfig): ReceiverAssembly {
  const logger = createLogger({ level: config.logLevel, serviceName: 'trace-receiver' });
  // mode=otlp 缺端点在此启动期 fail-fast(observabilityErrors.otel_endpoint_missing 单一所有者)
  const otel = initOtel({
    serviceName: 'trace-receiver',
    mode: config.otelMode,
    endpoint: config.otelEndpoint,
    logger,
  });
  const db = createDb({ url: config.databaseUrl, ...config.dbPool });
  const store = createPgTraceStore(db);
  const batcher = createSpanBatcher(store, {
    max: config.queueMax,
    batchMax: config.batchMax,
    flushIntervalMs: config.flushIntervalMs,
  });
  return { logger, otel, db, store, batcher };
}
