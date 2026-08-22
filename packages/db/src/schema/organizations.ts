import { pgTable, bigserial, bigint, varchar, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * organizations — 组织（企业/团队，org/member 计费模型）。
 * owner 也是成员（org_members 里占 1 席），订阅挂 org_id。
 */
export const organizations = pgTable('organizations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  ownerUserId: bigint('owner_user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
