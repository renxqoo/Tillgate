import { jsonb } from './jsonb.js';
/**
 * 幂等操作档案表（自 packages/ledger-core/src/schema.ts 平移——表定义唯一家收敛到本包）：
 *
 *   ledger_operations   operation_id 全局唯一（幂等键=调用方设计责任）+ fingerprint
 *                       （canonical 参数指纹——同键不同参=冲突）+ receipt（回执 jsonb——
 *                       重放的原样归还物）。操作行与业务写在同一事务：要么同生
 *                       （执行完成且回执落档）要么同死（execute 抛错整体回滚）。
 */
import {
  bigserial,
  index,
    pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

export const ledgerOperations = pgTable(
  'ledger_operations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    operationId: varchar('operation_id', { length: 128 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    receipt: jsonb('receipt'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 幂等键全局唯一：并发同键的第二个 INSERT 阻塞在索引上直到首个事务终结——
    // 提交则走重放读回，回滚则接棒执行。单语句定序，无死锁面。
    uniqueIndex('ledger_operations_operation_id_uq').on(t.operationId),
    // 读侧分页：kind 过滤 + id 倒序
    index('ledger_operations_kind_id_idx').on(t.kind, t.id),
  ],
);

// schema.ts 原文件的 provision/deprovision 属旧包运行时职责，不随表定义迁移；
// DDL 单一真源在 packages/db/migrations/0059。
