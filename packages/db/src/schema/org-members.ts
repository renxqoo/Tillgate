import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  smallint,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * org_members — 组织成员关系。
 * 席位 = active 成员数 ≤ 订阅 quantity（邀请接受事务内 FOR UPDATE 串行化校验）。
 * 成员可属于多个组织（不加 unique(user_id)）。
 */
export const orgMembers = pgTable(
  'org_members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    /** owner / member */
    role: varchar('role', { length: 16 }).notNull().default('member'),
    /** 0 active / 1 left */
    status: smallint('status').notNull().default(0),
    /** 成员日限（a）：该成员在 org 套餐内单日封顶（元，NULL=不限）。 */
    dailySpendLimit: numeric('daily_spend_limit', { precision: 38, scale: 18 }),
    /** 成员子配额（b）：该成员在共享额度池中分到的额度上限（元，NULL=不限）。 */
    monthlyQuota: numeric('monthly_quota', { precision: 38, scale: 18 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('org_members_org_user_uq').on(t.orgId, t.userId),
    index('org_members_user_idx').on(t.userId),
    index('org_members_org_status_idx').on(t.orgId, t.status),
  ],
);
