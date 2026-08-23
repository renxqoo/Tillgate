import {
  check,
  index,
  pgTable,
  bigserial,
  bigint,
  smallint,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * referrals — 邀请关系
 * 一个人只能被邀请一次（invitee 唯一）；注册奖励与日结佣金均以 fund_operations
 * 自然键幂等（referral-signup:{inviteeId}:{side} / referral-commission:{inviterId}:{yyyyMMdd}）。
 */
export const referrals = pgTable(
  'referrals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    inviterUserId: bigint('inviter_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    inviteeUserId: bigint('invitee_user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    /** 0 有效 / 1 封禁（作弊判定后停止返佣） */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('referrals_invitee_uq').on(t.inviteeUserId),
    index('referrals_inviter_created_idx').on(t.inviterUserId, t.createdAt),
    check('referrals_self_invite_ck', sql`${t.inviterUserId} <> ${t.inviteeUserId}`),
    check('referrals_status_ck', sql`${t.status} in (0, 1)`),
  ],
);
