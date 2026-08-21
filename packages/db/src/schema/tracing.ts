import {
  pgTable,
  varchar,
  timestamp,
  bigint,
  smallint,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * trace_spans — 链路 span 存储（tracing 接收端写入，admin 查询）。
 *
 * 分区：按 start_time RANGE 日分区（DDL 见迁移 0028，维护见 @ai-gateway/tracing partition）。
 * 数据等级：诊断数据（best-effort）——接收端过载即丢，绝不反压业务；与计费账本同库不同表，
 * 靠提升列（request_id/user_id/channel/model）实现计费关联点查。
 *
 * 领域属性提升列：OTel attributes 里的 request.id/user.id/channel.key/ai.model
 * 在接收时提取为真实列并建索引，attributes 原样保留完整 JSONB。
 */
export const traceSpans = pgTable(
  'trace_spans',
  {
    traceId: varchar('trace_id', { length: 32 }).notNull(),
    spanId: varchar('span_id', { length: 16 }).notNull(),
    parentSpanId: varchar('parent_span_id', { length: 16 }),
    name: varchar('name', { length: 256 }).notNull(),
    service: varchar('service', { length: 64 }).notNull(),
    startTime: timestamp('start_time', { withTimezone: true, mode: 'date' }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true, mode: 'date' }).notNull(),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
    /** OTel StatusCode：0=UNSET 1=OK 2=ERROR */
    statusCode: smallint('status_code').notNull().default(0),
    statusMessage: varchar('status_message', { length: 512 }),
    /** 提升列：网关请求 ID（计费关联点查入口） */
    requestId: varchar('request_id', { length: 64 }),
    /** 提升列：用户 ID */
    userId: bigint('user_id', { mode: 'number' }),
    /** 提升列：渠道标识 */
    channel: varchar('channel', { length: 64 }),
    /** 提升列：模型名 */
    model: varchar('model', { length: 128 }),
    /** 完整 span 属性（含未提升的所有键） */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** span events（异常等） */
    events: jsonb('events')
      .$type<Array<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trace_spans_trace_id_idx').on(t.traceId),
    index('trace_spans_request_id_idx').on(t.requestId),
    index('trace_spans_start_time_idx').on(t.startTime),
  ],
);
