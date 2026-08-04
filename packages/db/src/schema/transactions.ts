import { pgTable, bigserial, varchar, timestamp, bigint, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * transactions — 资金流水（余额变化的唯一依据，data-model.md §3.11）
 * type: consume 扣费 / redeem 充值码 / gift 系统赠送 / manual 管理员调账 / refund 退款 / subscribe 购买套餐（二期）
 */
export const transactions = pgTable(
  'transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    type: varchar('type', { length: 16 }).notNull(),
    /** 有符号：负=支出，正=收入 */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    balanceBefore: bigint('balance_before', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
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
  ],
)
