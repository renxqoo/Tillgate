import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  bigint,
  index,
  uniqueIndex,
  numeric,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * transactions — 资金流水（余额变化的唯一依据，data-model.md §3.11）
 * type: consume 扣费 / redeem 充值码 / gift 系统赠送 / manual 管理员调账 / refund 退款 / subscribe 购买套餐（二期）
 *
 * 幂等保障：consume 类型按 (ref_type, ref_id) 部分唯一索引——同一 requestId 只能产生一条扣费流水，
 * 防 worker 重试/并发导致重复扣费（与 usage_logs.request_id 唯一约束双保险）。
 */
export const transactions = pgTable(
  'transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    type: varchar('type', { length: 16 }).notNull(),
    /** 有符号：负=支出，正=收入（元，numeric(38,18) 全精度） */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 38, scale: 18 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 38, scale: 18 }).notNull(),
    /** 来源关联（usage_logs.request_id / redeem_codes.id / 管理员） */
    refType: varchar('ref_type', { length: 32 }),
    refId: varchar('ref_id', { length: 64 }),
    remark: varchar('remark', { length: 255 }),
    /** 管理员操作时记录；系统任务为 NULL */
    createdBy: bigint('created_by', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transactions_user_created_idx').on(t.userId, t.createdAt),
    index('transactions_type_created_idx').on(t.type, t.createdAt),
    index('transactions_ref_idx').on(t.refType, t.refId),
    // 部分唯一索引：consume（扣费）+ redeem（充值码）按来源去重
    // worker 结算用 ON CONFLICT DO NOTHING，重复 job 只写一条流水
    // redeem 也加幂等：防双击/重试导致重复入账（R-2 修复）
    uniqueIndex('transactions_consume_ref_uq')
      .on(t.refType, t.refId)
      .where(sql`ref_type = 'usage_logs'`),
    uniqueIndex('transactions_redeem_ref_uq')
      .on(t.refType, t.refId)
      .where(sql`ref_type = 'redeem_codes'`),
    // signup_gift 幂等：防并发首次登录双倍赠送（#6 修复）
    uniqueIndex('transactions_gift_ref_uq')
      .on(t.refType, t.refId)
      .where(sql`ref_type = 'signup_gift'`),
    // subscribe 幂等：同一订阅周期只产生一条购买流水
    uniqueIndex('transactions_subscription_ref_uq')
      .on(t.refType, t.refId)
      .where(sql`ref_type = 'subscription'`),
  ],
);
