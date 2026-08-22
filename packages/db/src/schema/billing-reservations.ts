import {
  bigint,
  bigserial,
  check,
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { billingRequests } from './billing-requests.js';

/**
 * 预扣明细（资金来源瀑布的真相表）：一行 = 一个来源为该请求预占的金额。
 * billing_requests 三列（reserved_amount / plan_reserved_amount / subscription_id）
 * 是本表的投影，worker 上线后删投影列；释放/结算按明细逐笔走对应来源。
 */
export const billingReservations = pgTable(
  'billing_reservations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    billingRequestId: uuid('billing_request_id')
      .notNull()
      .references(() => billingRequests.requestId),
    /** payg / subscription /（将来）promo / enterprise */
    sourceType: varchar('source_type', { length: 32 }).notNull(),
    /** 来源行引用（subscription 的订阅 id；payg 为 NULL） */
    sourceRefId: bigint('source_ref_id', { mode: 'number' }),
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    /** active / released / settled（单向；同请求同来源至多一行 active） */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_reservations_request_idx')
      .on(t.billingRequestId)
      .where(sql`status = 'active'`),
    index('billing_reservations_source_idx')
      .on(t.sourceType, t.sourceRefId)
      .where(sql`status = 'active'`),
    // 全量索引：清理脚本/对账要扫 released/settled 行，partial 索引盖不到
    index('billing_reservations_request_all_idx').on(t.billingRequestId),
    // 同请求同来源至多一行 active：重放双预留的结构性防线
    uniqueIndex('billing_reservations_request_source_uq')
      .on(t.billingRequestId, t.sourceType)
      .where(sql`status = 'active'`),
    check('billing_reservations_amount_positive', sql`${t.amount} > 0`),
    check('billing_reservations_status_valid', sql`${t.status} in ('active','released','settled')`),
    check(
      'billing_reservations_status_ts',
      sql`(${t.status} = 'active' and ${t.releasedAt} is null and ${t.settledAt} is null)
          or (${t.status} = 'released' and ${t.releasedAt} is not null and ${t.settledAt} is null)
          or (${t.status} = 'settled' and ${t.settledAt} is not null and ${t.releasedAt} is null)`,
    ),
  ],
);
