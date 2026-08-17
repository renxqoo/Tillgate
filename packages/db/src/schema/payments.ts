import {
  check,
  index,
  pgTable,
  smallint,
  timestamp,
  uuid,
  varchar,
  numeric,
  jsonb,
  bigint,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { fundOperations } from './fund-operations.js';

/**
 * payment_orders — 在线支付订单（data-model.md §3.16）
 * 状态机：0 created → 1 paid（回调确认）→ 2 credited（入账完成）→ 3 refunded；
 *          0 → 4 expired（超时未支付/手动关闭）。迁移合法性由入账事务的条件 UPDATE 保证。
 * 入账幂等：ledger.paymentCredit 以 operationId=payment-credit:{provider}:{provider_order_id}
 * 走 fund_operations 抢占 + transactions 部分唯一索引（ref_type='payment_orders'）双保险。
 */
export const paymentOrders = pgTable(
  'payment_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** epay / stripe（PaymentProvider 注册表键） */
    provider: varchar('provider', { length: 16 }).notNull(),
    /** 渠道侧订单号（易支付 trade_no/商户订单号、Stripe Checkout Session id） */
    providerOrderId: varchar('provider_order_id', { length: 128 }).notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    /** 实付金额（法币，元） */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('CNY'),
    /** 入账余额金额（元）；创建时由 amount × 充值汇率定死，回调只认订单不重算 */
    creditAmount: numeric('credit_amount', { precision: 38, scale: 18 }).notNull(),
    /** 0 created / 1 paid / 2 credited / 3 refunded / 4 expired */
    status: smallint('status').notNull().default(0),
    /** 入账幂等锚点（fund_operations.operation_id） */
    creditedOperationId: varchar('credited_operation_id', { length: 128 }).references(
      () => fundOperations.operationId,
    ),
    failureReason: varchar('failure_reason', { length: 255 }),
    /** 创建参数与回调原始载荷（审计；不参与结算，结算只认 credit_amount） */
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('payment_orders_provider_order_uq').on(t.provider, t.providerOrderId),
    index('payment_orders_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('payment_orders_status_created_idx').on(t.status, t.createdAt),
    check('payment_orders_provider_ck', sql`${t.provider} in ('epay','stripe')`),
    check('payment_orders_status_ck', sql`${t.status} in (0, 1, 2, 3, 4)`),
    check('payment_orders_amounts_positive_ck', sql`${t.amount} > 0 and ${t.creditAmount} > 0`),
  ],
);
