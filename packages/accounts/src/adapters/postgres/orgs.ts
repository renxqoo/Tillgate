/**
 * 组织/成员/邀请聚合 SQL:席位不变量编排件(CAS/FOR UPDATE/复活)、
 * 订阅绑定守卫(G8:user_subscriptions 只读最小投影)。
 */
import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { orgInvitations, orgMembers, organizations, userSubscriptions, users } from '@tillgate/db';
import type { AccountStorePort } from '../../ports/account-store.js';
import { nowSql } from './shared.js';

const MEMBER_COLUMNS = {
  id: orgMembers.id,
  orgId: orgMembers.orgId,
  userId: orgMembers.userId,
  role: orgMembers.role,
  status: orgMembers.status,
  dailySpendLimit: orgMembers.dailySpendLimit,
  monthlyQuota: orgMembers.monthlyQuota,
  createdAt: orgMembers.createdAt,
  updatedAt: orgMembers.updatedAt,
} as const;

const INVITATION_COLUMNS = {
  id: orgInvitations.id,
  orgId: orgInvitations.orgId,
  email: orgInvitations.email,
  invitedByUserId: orgInvitations.invitedByUserId,
  status: orgInvitations.status,
  expiresAt: orgInvitations.expiresAt,
  acceptedByUserId: orgInvitations.acceptedByUserId,
  createdAt: orgInvitations.createdAt,
} as const;

const activeSub = (orgId: number) =>
  and(
    eq(userSubscriptions.orgId, orgId),
    eq(userSubscriptions.status, 0),
    gt(userSubscriptions.endAt, nowSql),
  );

export const orgQueries: Pick<
  AccountStorePort,
  | 'insertOrgWithOwner'
  | 'findOrg'
  | 'findActiveMembership'
  | 'listMembershipsForUser'
  | 'listMembers'
  | 'countActiveMembers'
  | 'countPendingInvitations'
  | 'insertInvitation'
  | 'findInvitationByToken'
  | 'listPendingInvitations'
  | 'revokeInvitation'
  | 'insertOrReviveMember'
  | 'acceptInvitation'
  | 'findActiveOrgSubscription'
  | 'lockActiveOrgSubscription'
  | 'patchMember'
  | 'removeMember'
  | 'findUsableSubscription'
  | 'memberLimits'
> = {
  async insertOrgWithOwner(db, { name, ownerUserId }) {
    return db.transaction(async (tx) => {
      const orgRows = await tx.insert(organizations).values({ name, ownerUserId }).returning({
        id: organizations.id,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        name: organizations.name,
        ownerUserId: organizations.ownerUserId,
      });
      const [org] = orgRows;
      if (org === undefined) throw new Error('insertOrgWithOwner returning empty');
      await tx.insert(orgMembers).values({ orgId: org.id, userId: ownerUserId, role: 'owner' });
      return org;
    });
  },

  async findOrg(db, orgId) {
    const rows = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return rows[0] ?? null;
  },

  async findActiveMembership(db, { orgId, userId }) {
    const rows = await db
      .select(MEMBER_COLUMNS)
      .from(orgMembers)
      .where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listMembershipsForUser(db, userId) {
    return db
      .select({ ...MEMBER_COLUMNS, orgName: organizations.name })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, 0)));
  },

  async listMembers(db, orgId) {
    return db
      .select({
        userId: orgMembers.userId,
        displayName: users.displayName,
        email: users.email,
        subject: users.subject,
        role: orgMembers.role,
        status: orgMembers.status,
        dailySpendLimit: orgMembers.dailySpendLimit,
        monthlyQuota: orgMembers.monthlyQuota,
        joinedAt: orgMembers.createdAt,
      })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.orgId, orgId))
      .orderBy(asc(orgMembers.id));
  },

  async countActiveMembers(db, orgId) {
    const rows = await db
      .select({ value: count() })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 0)));
    return rows[0]?.value ?? 0;
  },

  async countPendingInvitations(db, orgId) {
    const rows = await db
      .select({ value: count() })
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, orgId),
          eq(orgInvitations.status, 0),
          gt(orgInvitations.expiresAt, nowSql),
        ),
      );
    return rows[0]?.value ?? 0;
  },

  async insertInvitation(db, input) {
    const rows = await db
      .insert(orgInvitations)
      .values({
        orgId: input.orgId,
        email: input.email,
        token: input.token,
        invitedByUserId: input.invitedByUserId,
        expiresAt: sql`clock_timestamp() + (${input.ttlMs} * interval '1 millisecond')`,
      })
      .returning({ ...INVITATION_COLUMNS, token: orgInvitations.token });
    const [row] = rows;
    if (row === undefined) throw new Error('insertInvitation returning empty');
    return row;
  },

  async findInvitationByToken(db, token) {
    const rows = await db
      .select({
        ...INVITATION_COLUMNS,
        token: orgInvitations.token,
        expired: sql<boolean>`${orgInvitations.expiresAt} <= clock_timestamp()`,
      })
      .from(orgInvitations)
      .where(eq(orgInvitations.token, token))
      .limit(1);
    return rows[0] ?? null;
  },

  async listPendingInvitations(db, orgId) {
    return db
      .select(INVITATION_COLUMNS)
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, orgId),
          eq(orgInvitations.status, 0),
          gt(orgInvitations.expiresAt, nowSql),
        ),
      )
      .orderBy(desc(orgInvitations.id));
  },

  async revokeInvitation(db, { orgId, invitationId }) {
    const rows = await db
      .update(orgInvitations)
      .set({ status: 2, updatedAt: nowSql })
      .where(
        and(
          eq(orgInvitations.id, invitationId),
          eq(orgInvitations.orgId, orgId),
          eq(orgInvitations.status, 0),
        ),
      )
      .returning({ id: orgInvitations.id });
    return rows.length > 0;
  },

  async insertOrReviveMember(db, { orgId, userId, role }) {
    // setWhere status=1:被移除成员经新邀请复活(v1 语义);active 行冲突为无害幂等
    await db
      .insert(orgMembers)
      .values({ orgId, userId, role })
      .onConflictDoUpdate({
        target: [orgMembers.orgId, orgMembers.userId],
        set: { status: 0, role, updatedAt: nowSql },
        setWhere: eq(orgMembers.status, 1),
      });
  },

  async acceptInvitation(db, { invitationId, acceptedByUserId }) {
    // 原子翻转:pending + 未过期 → accepted;0 行 = 并发竞态(调用方回滚)
    const rows = await db
      .update(orgInvitations)
      .set({ status: 1, acceptedByUserId, updatedAt: nowSql })
      .where(
        and(
          eq(orgInvitations.id, invitationId),
          eq(orgInvitations.status, 0),
          gt(orgInvitations.expiresAt, nowSql),
        ),
      )
      .returning({ id: orgInvitations.id });
    return rows.length > 0;
  },

  async findActiveOrgSubscription(db, orgId) {
    const rows = await db
      .select({ id: userSubscriptions.id, quantity: userSubscriptions.quantity })
      .from(userSubscriptions)
      .where(activeSub(orgId))
      .limit(1);
    return rows[0] ?? null;
  },

  async lockActiveOrgSubscription(db, orgId) {
    const rows = await db
      .select({ id: userSubscriptions.id, quantity: userSubscriptions.quantity })
      .from(userSubscriptions)
      .where(activeSub(orgId))
      .for('update')
      .limit(1);
    return rows[0] ?? null;
  },

  async patchMember(db, { orgId, userId, patch }) {
    const set: Record<string, unknown> = { updatedAt: nowSql };
    if (patch.dailySpendLimit !== undefined) set.dailySpendLimit = patch.dailySpendLimit;
    if (patch.monthlyQuota !== undefined) set.monthlyQuota = patch.monthlyQuota;
    // B5 修复:仅 active 成员可设限(v1 不过滤 status,已离开成员仍可被设限)
    const rows = await db
      .update(orgMembers)
      .set(set)
      .where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)),
      )
      .returning(MEMBER_COLUMNS);
    return rows[0] ?? null;
  },

  async removeMember(db, { orgId, userId }) {
    const rows = await db
      .update(orgMembers)
      .set({ status: 1, updatedAt: nowSql })
      .where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)),
      )
      .returning({ id: orgMembers.id });
    return rows.length > 0;
  },

  async findUsableSubscription(db, { userId, subscriptionId }) {
    const rows = await db
      .select({ userId: userSubscriptions.userId, orgId: userSubscriptions.orgId })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.id, subscriptionId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, nowSql),
        ),
      )
      .limit(1);
    const [sub] = rows;
    if (sub === undefined) return null;
    if (sub.userId === userId) return { userId: sub.userId, orgId: sub.orgId };
    // 组织订阅:须为该组织 active 成员(v1 守卫口径)
    if (sub.orgId === null) return null;
    const member = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, sub.orgId),
          eq(orgMembers.userId, userId),
          eq(orgMembers.status, 0),
        ),
      )
      .limit(1);
    return member.length > 0 ? { userId: sub.userId, orgId: sub.orgId } : null;
  },

  async memberLimits(db, { orgId, userId }) {
    const rows = await db
      .select({
        dailySpendLimit: orgMembers.dailySpendLimit,
        monthlyQuota: orgMembers.monthlyQuota,
      })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  },
};
