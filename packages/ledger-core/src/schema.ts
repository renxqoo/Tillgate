/**
 * 幂等操作内核单表（业务无关，本包私有）：
 *
 *   ledger_operations   操作档案：operation_id 全局唯一（幂等键=调用方设计责任）
 *                       + fingerprint（canonical 参数指纹——同键不同参=冲突）
 *                       + receipt（回执 jsonb——重放的原样归还物）
 *
 * 操作行与业务写在同一事务：要么同生（执行完成且回执落档）要么同死（execute 抛错整体回滚）——
 * 「提交了但没有回执」的中间态在结构上不存在。
 */
import { sql } from 'drizzle-orm';
import { bigserial, index, jsonb, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import type { AnyPgDatabase } from './internal.js';

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

const LEDGER_DDL: readonly string[] = [
  `
    create table if not exists ledger_operations (
      id bigserial primary key,
      operation_id varchar(128) not null,
      kind varchar(32) not null,
      fingerprint varchar(64) not null,
      receipt jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint ledger_operations_operation_id_uq unique (operation_id)
    )`,
  `create index if not exists ledger_operations_kind_id_idx on ledger_operations (kind, id)`,
];

/** 一次性建表（幂等；独立 schema/独立库均可） */
export async function provision(db: AnyPgDatabase): Promise<void> {
  for (const statement of LEDGER_DDL) {
    await db.execute(sql.raw(statement));
  }
}

/** DDL 导出（消费方自己的迁移管线收录用；与 provision 同源同序） */
export function provisionSql(): readonly string[] {
  return LEDGER_DDL;
}

/** 测试清场：drop 表（业务环境勿用；操作档案是 append-only 审计物，生产不删） */
export async function deprovision(db: AnyPgDatabase): Promise<void> {
  await db.execute(sql`drop table if exists ledger_operations`);
}
