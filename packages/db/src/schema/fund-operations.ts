import { bigint, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * 资金操作幂等收据。
 *
 * operation_id 由业务入口提供（请求 ID 或稳定自然键）。同一 ID 只有在 kind 与
 * fingerprint 都一致时才允许重放；否则 Ledger 返回 idempotency_conflict。
 * result 保存首次提交的领域结果，让重试返回完全相同的前后余额和流水 ID。
 */
export const fundOperations = pgTable('fund_operations', {
  operationId: varchar('operation_id', { length: 128 }).primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  transactionId: bigint('transaction_id', { mode: 'number' }),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
