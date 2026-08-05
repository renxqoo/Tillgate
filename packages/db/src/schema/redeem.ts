import {
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  index,
  uniqueIndex,
  numeric,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** redeem_batches — 充值码批次（data-model.md §3.12，面额创建后不可修改） */
export const redeemBatches = pgTable(
  'redeem_batches',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    remark: varchar('remark', { length: 255 }),
    /** 统一面额（元，numeric 全精度） */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    total: bigint('total', { mode: 'number' }).notNull(),
    usedCount: bigint('used_count', { mode: 'number' }).notNull().default(0),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('redeem_batches_created_by_idx').on(t.createdBy)],
);

/** redeem_codes — 充值码（只存哈希，明文生成时下发） */
export const redeemCodes = pgTable(
  'redeem_codes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    batchId: bigint('batch_id', { mode: 'number' })
      .notNull()
      .references(() => redeemBatches.id),
    /** SHA-256 */
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    /** 0 未用 / 1 已用 / 2 作废 */
    status: smallint('status').notNull().default(0),
    usedBy: bigint('used_by', { mode: 'number' }).references(() => users.id),
    usedAt: timestamp('used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('redeem_codes_code_hash_uq').on(t.codeHash),
    index('redeem_codes_batch_idx').on(t.batchId),
    index('redeem_codes_used_by_idx').on(t.usedBy),
  ],
);
