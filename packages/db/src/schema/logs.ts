import {
  pgTable,
  bigserial,
  uuid,
  varchar,
  timestamp,
  bigint,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { admins } from './admins.js';
import { apiKeys } from './api-keys.js';

/**
 * request_logs — 请求日志（30 天滚动，按月分区 P1 实现；data-model.md §3.13）
 * 与 usage_logs 分工：本表为排障日志，usage_logs 为计费账本
 */
export const requestLogs = pgTable(
  'request_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestId: uuid('request_id').notNull(),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
    apiKeyId: bigint('api_key_id', { mode: 'number' }).references(() => apiKeys.id),
    method: varchar('method', { length: 8 }).notNull(),
    path: varchar('path', { length: 128 }).notNull(),
    statusCode: bigint('status_code', { mode: 'number' }).notNull(),
    errorCode: varchar('error_code', { length: 32 }),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
    /** 截断后的请求摘要（不含敏感内容），截断长度可配置（默认 2000 字符） */
    requestSummary: jsonb('request_summary'),
    /** 尝试渠道次数（排障/观测用） */
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(1),
    /** 尝试过的候选列表（渠道/模型与结果） */
    candidatesTried: jsonb('candidates_tried'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('request_logs_created_idx').on(t.createdAt),
    index('request_logs_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * audit_logs — 管理操作审计（data-model.md §3.14）
 * actor: admin / system（系统任务如对账/赠送/自动冻结，adminId 为 NULL）
 *
 * adminId 引用 admins.id（拆分后）：系统任务（赠送/对账）adminId 为 NULL，
 * 管理员手动操作 adminId 对应 admins.id。
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    adminId: bigint('admin_id', { mode: 'number' }).references(() => admins.id, {
      onDelete: 'set null',
    }),
    actor: varchar('actor', { length: 8 }).notNull().default('admin'),
    /** 如 channel.update / user.adjust */
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: varchar('target_id', { length: 64 }),
    /** 变更前后摘要 */
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt)],
);
