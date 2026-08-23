import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  smallint,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * org_invitations — 组织邀请。
 * 被邀请人须已登录 C 端，且登录账号 email 与邀请 email 一致才能接受。
 */
export const orgInvitations = pgTable(
  'org_invitations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id),
    email: varchar('email', { length: 255 }).notNull(),
    token: varchar('token', { length: 64 }).notNull(),
    invitedByUserId: bigint('invited_by_user_id', { mode: 'number' }).references(() => users.id),
    /** 0 pending / 1 accepted / 2 revoked / 3 expired */
    status: smallint('status').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedByUserId: bigint('accepted_by_user_id', { mode: 'number' }).references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('org_invitations_token_uq').on(t.token),
    index('org_invitations_org_idx').on(t.orgId),
    index('org_invitations_email_idx').on(t.email),
  ],
);
