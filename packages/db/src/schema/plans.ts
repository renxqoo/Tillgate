import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  bigint,
  boolean,
  smallint,
  index,
  uniqueIndex,
  numeric,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { organizations } from './organizations.js';

/**
 * 套餐与用户订阅表
 */

/** plans — 套餐定义 */
export const plans = pgTable(
  'plans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 32 }).notNull(),
    /** 'subscription' 包月 / 'pack' 加油包（一次性买积分，无到期无层级） */
    kind: varchar('kind', { length: 16 }).notNull().default('subscription'),
    /** 层级序号（lite=1 / pro=2 / max=3）；加油包为 NULL。升级/扩容只允许升不许降。 */
    sortOrder: bigint('sort_order', { mode: 'number' }),
    /** 售价（元，numeric 全精度） */
    price: numeric('price', { precision: 38, scale: 18 }).notNull(),
    /** 周期天数（30 / 365）；加油包为 0（一次性，无周期） */
    periodDays: bigint('period_days', { mode: 'number' }).notNull(),
    /** 金额额度（元，按「官方价×系数」折算扣减，与按量同口径）；加油包=到账额度 */
    quotaAmount: numeric('quota_amount', { precision: 38, scale: 18 }).notNull(),
    /** 是否支持席位（团队套餐）：true=可 quantity>1 加份；false=固定 1 席（个人套餐） */
    allowSeats: boolean('allow_seats').notNull().default(false),
    /** 0 启用 / 1 停用 */
    status: smallint('status').notNull().default(0),
  },
  (t) => [index('plans_name_idx').on(t.name)],
);

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
    /** 额度快照（元）= 档额度 × 席位，购买/变更时落库 */
    quotaAmount: numeric('quota_amount', { precision: 38, scale: 18 }).notNull(),
    /** 已用额度（元，原子扣减，同余额模式） */
    usedAmount: numeric('used_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 在途敞口（元）：所有未终结请求对套餐额度的预占之和，结算/释放时清。 */
    reservedAmount: numeric('reserved_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 席位/数量（共享额度池：总额度 = 档额度 × 席位）。默认 1。 */
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(1),
    /** 组织订阅：org_id 非空 = 企业/团队订阅（user_id=owner）；NULL = 个人订阅。 */
    orgId: bigint('org_id', { mode: 'number' }).references(() => organizations.id),
    /** 订阅总价快照（元）= 档价 × 席位，购买时落库；升级算「剩余价值」用。 */
    price: numeric('price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 0 有效 / 1 到期 / 2 取消 */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_subscriptions_user_idx').on(t.userId),
    index('user_subscriptions_plan_idx').on(t.planId),
    index('user_subscriptions_org_idx').on(t.orgId),
    // 「单有效订阅」硬不变量，两个维度：
    //   用户：每用户至多一条 active（个人或组织皆然，覆盖 ensureOrg 并发建多 org 的绕过）。
    //   组织：每组织至多一条 active（防跨用户在同一组织重复开订阅）。
    uniqueIndex('user_subscriptions_one_active_uq')
      .on(t.userId)
      .where(sql`${t.status} = 0`),
    uniqueIndex('user_subscriptions_one_org_uq')
      .on(t.orgId)
      .where(sql`${t.status} = 0 and ${t.orgId} is not null`),
    // 套餐额度「永不为负」硬不变量：已用 + 在途 ≤ 额度，且二者非负。
    check('user_subscriptions_used_nonnegative_ck', sql`${t.usedAmount} >= 0`),
    check('user_subscriptions_reserved_nonnegative_ck', sql`${t.reservedAmount} >= 0`),
    check(
      'user_subscriptions_within_quota_ck',
      sql`${t.usedAmount} + ${t.reservedAmount} <= ${t.quotaAmount}`,
    ),
    check('user_subscriptions_quantity_positive_ck', sql`${t.quantity} >= 1`),
    check('user_subscriptions_price_nonnegative_ck', sql`${t.price} >= 0`),
  ],
);
