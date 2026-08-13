import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * 请求级计费状态机，也是结算收据的 durable outbox。
 * PostgreSQL 是资金唯一事实源；Redis/BullMQ 仅负责低延迟唤醒。
 */
export const billingRequests = pgTable(
  'billing_requests',
  {
    requestId: uuid('request_id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    reservedAmount: numeric('reserved_amount', { precision: 38, scale: 18 }).notNull(),
    /** authorized/in_flight/settlement_pending/processing/retry_wait/settled/released/uncertain/dead */
    status: varchar('status', { length: 32 }).notNull().default('authorized'),
    /** 每次状态迁移递增；同时作为 worker fencing token。 */
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    stream: boolean('stream').notNull().default(false),
    quote: jsonb('quote').$type<Record<string, unknown>>().notNull(),
    authorizationFingerprint: varchar('authorization_fingerprint', { length: 64 }).notNull(),
    receipt: jsonb('receipt').$type<Record<string, unknown>>(),
    receiptFingerprint: varchar('receipt_fingerprint', { length: 64 }),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    upstreamStartedAt: timestamp('upstream_started_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 64 }),
    settlementAttempts: bigint('settlement_attempts', { mode: 'number' }).notNull().default(0),
    nextSettlementAt: timestamp('next_settlement_at', { withTimezone: true }),
    claimOwner: varchar('claim_owner', { length: 128 }),
    claimToken: uuid('claim_token'),
    claimUntil: timestamp('claim_until', { withTimezone: true }),
    failureClass: varchar('failure_class', { length: 64 }),
    lastError: text('last_error'),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_requests_user_status_idx').on(t.userId, t.status),
    index('billing_requests_status_created_idx').on(t.status, t.createdAt),
    index('billing_requests_pending_idx').on(t.status, t.nextSettlementAt),
    index('billing_requests_lease_idx').on(t.status, t.leaseExpiresAt),
    index('billing_requests_claim_idx').on(t.status, t.claimUntil),
    uniqueIndex('billing_requests_claim_token_uq').on(t.claimToken),
    check(
      'billing_requests_status_ck',
      sql`${t.status} in ('authorized','in_flight','settlement_pending','processing','retry_wait','settled','released','uncertain','dead')`,
    ),
    check(
      'billing_requests_receipt_state_ck',
      sql`(${t.status} not in ('settlement_pending','processing','retry_wait','settled','dead')) or ${t.receipt} is not null`,
    ),
    check(
      'billing_requests_claim_state_ck',
      sql`(${t.status} = 'processing') = (${t.claimToken} is not null and ${t.claimOwner} is not null and ${t.claimUntil} is not null)`,
    ),
  ],
);
