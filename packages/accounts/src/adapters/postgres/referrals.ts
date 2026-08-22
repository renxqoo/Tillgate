/**
 * 推荐与拉新参数聚合 SQL:关系/名单、单行表 upsert(B7 单往返)、管理面关系视图。
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { marketingSettings, referrals, users } from '@tokenlens/db';
import { ZERO_MARKETING_SETTINGS } from '../../domain/marketing.js';
import type { AccountStorePort, RelationView } from '../../ports/account-store.js';
import { likePattern, nowSql } from './shared.js';

/** 关系视图 raw SQL(自联两次 users;q 命中任一侧账号) */
const RELATION_VIEW_SQL = `
  select r.id, r.inviter_user_id, r.invitee_user_id, r.status, r.created_at,
         i.email as inviter_email, i.display_name as inviter_display_name,
         e.email as invitee_email, e.display_name as invitee_display_name
  from referrals r
  join users i on i.id = r.inviter_user_id
  join users e on e.id = r.invitee_user_id
`;

/** raw 行 → 视图(snake_case → camelCase;类型收口在本模块) */
function toRelationView(r: Record<string, unknown>): RelationView {
  return {
    id: r.id as number,
    inviterUserId: r.inviter_user_id as number,
    inviterEmail: (r.inviter_email as string | null) ?? null,
    inviterDisplayName: (r.inviter_display_name as string | null) ?? null,
    inviteeUserId: r.invitee_user_id as number,
    inviteeEmail: (r.invitee_email as string | null) ?? null,
    inviteeDisplayName: (r.invitee_display_name as string | null) ?? null,
    status: r.status as number,
    createdAt: r.created_at as Date,
  };
}

export const referralQueries: Pick<
  AccountStorePort,
  | 'inviterActive'
  | 'insertReferral'
  | 'listInvitees'
  | 'getMarketingSettings'
  | 'upsertMarketingSettings'
  | 'listReferralRelations'
  | 'setReferralRelationStatus'
> = {
  async inviterActive(db, inviterUserId) {
    const rows = await db
      .select({ one: sql<number>`1` })
      .from(users)
      .where(and(eq(users.id, inviterUserId), eq(users.status, 0)))
      .limit(1);
    return rows.length > 0;
  },

  async insertReferral(db, { inviterUserId, inviteeUserId }) {
    const rows = await db
      .insert(referrals)
      .values({ inviterUserId, inviteeUserId })
      .onConflictDoNothing({ target: referrals.inviteeUserId })
      .returning({ id: referrals.id });
    return rows.length > 0 ? 'created' : 'already_referred';
  },

  async listInvitees(db, { inviterUserId, limit }) {
    return db
      .select({
        inviteeUserId: referrals.inviteeUserId,
        inviteeEmail: users.email,
        inviteeDisplayName: users.displayName,
        status: referrals.status,
        createdAt: referrals.createdAt,
      })
      .from(referrals)
      .innerJoin(users, eq(referrals.inviteeUserId, users.id))
      .where(eq(referrals.inviterUserId, inviterUserId))
      .orderBy(desc(referrals.id))
      .limit(limit);
  },

  async getMarketingSettings(db) {
    const rows = await db
      .select()
      .from(marketingSettings)
      .where(eq(marketingSettings.id, 1))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      // 缺行兜底 = domain 零值常量(单一真相)+ epoch0(v1 getSettings 语义)
      return { ...ZERO_MARKETING_SETTINGS, updatedBy: null, updatedAt: new Date(0) };
    }
    return {
      signupGiftAmount: row.signupGiftAmount,
      referralSignupBonus: row.referralSignupBonus,
      referralCommissionRate: row.referralCommissionRate,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  },

  async upsertMarketingSettings(db, { patch, updatedBy }) {
    const set: Record<string, unknown> = { updatedAt: nowSql, updatedBy };
    if (patch.signupGiftAmount !== undefined) set.signupGiftAmount = patch.signupGiftAmount;
    if (patch.referralSignupBonus !== undefined) set.referralSignupBonus = patch.referralSignupBonus;
    if (patch.referralCommissionRate !== undefined)
      set.referralCommissionRate = patch.referralCommissionRate;
    // B7 修复:insert onConflictDoUpdate ... returning 单往返(v1 upsert 后回读两往返)
    const rows = await db
      .insert(marketingSettings)
      .values({ id: 1, ...set })
      .onConflictDoUpdate({ target: marketingSettings.id, set })
      .returning({
        signupGiftAmount: marketingSettings.signupGiftAmount,
        referralSignupBonus: marketingSettings.referralSignupBonus,
        referralCommissionRate: marketingSettings.referralCommissionRate,
        updatedBy: marketingSettings.updatedBy,
        updatedAt: marketingSettings.updatedAt,
      });
    const row = rows[0];
    if (row === undefined) throw new Error('upsertMarketingSettings returning empty');
    return row;
  },

  async listReferralRelations(db, input) {
    const offset = (input.page - 1) * input.limit;
    const filter = input.q
      ? sql`where i.email ilike ${likePattern(input.q)} or i.display_name ilike ${likePattern(input.q)}
              or e.email ilike ${likePattern(input.q)} or e.display_name ilike ${likePattern(input.q)}`
      : sql``;
    const rows = await db.execute(sql`
      ${sql.raw(RELATION_VIEW_SQL)}
      ${filter}
      order by r.id desc
      limit ${input.limit} offset ${offset}
    `);
    const totalRows = await db.execute(sql`
      select count(*)::int as value from referrals r
      join users i on i.id = r.inviter_user_id
      join users e on e.id = r.invitee_user_id
      ${filter}
    `);
    const list = (rows.rows as Array<Record<string, unknown>>).map(toRelationView);
    return {
      rows: list,
      total: (totalRows.rows[0] as { value: number } | undefined)?.value ?? 0,
    };
  },

  async setReferralRelationStatus(db, { relationId, status }) {
    const rows = await db
      .update(referrals)
      .set({ status })
      .where(eq(referrals.id, relationId))
      .returning({ id: referrals.id });
    if (rows.length === 0) return null;
    const view = await db.execute(sql`${sql.raw(RELATION_VIEW_SQL)} where r.id = ${relationId}`);
    const r = (view.rows[0] ?? null) as Record<string, unknown> | null;
    return r === null ? null : toRelationView(r);
  },
};
