import { pgTable, bigserial, varchar, timestamp, bigint, boolean, smallint, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * 二期表（一期建表，业务逻辑二期启用；data-model.md §3.15）
 */

/** plans — 套餐定义 */
export const plans = pgTable(
  'plans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 32 }).notNull(),
    /** 售价（厘） */
    price: bigint('price', { mode: 'number' }).notNull(),
    /** 周期天数（30 / 365） */
    periodDays: bigint('period_days', { mode: 'number' }).notNull(),
    /** 金额额度（厘，按「官方价×系数」折算扣减，与按量同口径） */
    quotaAmount: bigint('quota_amount', { mode: 'number' }).notNull(),
    /** 额度耗尽后是否允许用余额（默认 true，套餐级开关） */
    fallbackToBalance: boolean('fallback_to_balance').notNull().default(true),
    /** 0 启用 / 1 停用 */
    status: smallint('status').notNull().default(0),
  },
  (t) => [index('plans_name_idx').on(t.name)],
)

/** user_subscriptions — 用户订阅 */
export const userSubscriptions = pgTable(
  'user_subscriptions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    planId: bigint('plan_id', { mode: 'number' })
      .notNull()
      .references(() => plans.id),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    /** 额度快照（厘） */
    quotaAmount: bigint('quota_amount', { mode: 'number' }).notNull(),
    /** 已用额度（厘，原子扣减，同余额模式） */
    usedAmount: bigint('used_amount', { mode: 'number' }).notNull().default(0),
    /** 0 有效 / 1 到期 / 2 取消 */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_subscriptions_user_idx').on(t.userId), index('user_subscriptions_plan_idx').on(t.planId)],
)
