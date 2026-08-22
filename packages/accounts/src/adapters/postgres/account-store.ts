/**
 * Postgres AccountStore 适配器:全量账号 SQL(drizzle;D2 helper 单点)。
 *
 * 语义契约(与 testing 内存替身同拍演进,DESIGN §5):
 * - 时间单一来源 = clock_timestamp()(写入/过期判定;B4/B6 修复);
 * - 状态翻转 CAS 单语句,0 行 → null/false;
 * - 投影结构性排除秘密列(keyHash/clientSecretHash/passwordHash);
 * - ilike 走转义;排序附 desc(id) 稳定 tiebreaker;
 * - 唯一冲突翻译只在 insertLocalUser(email_taken);其余 23505 原样上抛,
 *   由 app face 的 PG 边界翻译族处理(ADR-0002)。
 * - user_subscriptions 只读最小投影 {id, quantity}(G8:席位事实归 billing,
 *   FOR UPDATE 与 billing 侧数量变更同锁互斥)。
 */
import { and, asc, count, desc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  apiKeys,
  apps,
  marketingSettings,
  orgInvitations,
  orgMembers,
  organizations,
  rateCards,
  referrals,
  userSubscriptions,
  users,
} from '@tokenlens/db';
import { isUniqueViolation } from '@tokenlens/db';
import type { AccountStorePort } from '../../ports/account-store.js';

// ---- 公共 helper(D2 收敛) ----

/** ilike 转义:%/_/\ 失去通配义(PG LIKE 默认转义符为反斜杠) */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function likePattern(q: string): string {
  return `%${escapeLikePattern(q)}%`;
}

const nowSql = sql`clock_timestamp()`;

// ---- 投影(结构性排除秘密列) ----

const USER_COLUMNS = {
  id: users.id,
  issuer: users.issuer,
  subject: users.subject,
  identityProvider: users.identityProvider,
  email: users.email,
  displayName: users.displayName,
  rateCardId: users.rateCardId,
  dailySpendLimit: users.dailySpendLimit,
  status: users.status,
  sessionInvalidBefore: users.sessionInvalidBefore,
  isEnterprise: users.isEnterprise,
  freezeReason: users.freezeReason,
  rpmLimit: users.rpmLimit,
  tpmLimit: users.tpmLimit,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

const KEY_COLUMNS = {
  id: apiKeys.id,
  keyPreview: apiKeys.keyPreview,
  userId: apiKeys.userId,
  appId: apiKeys.appId,
  subscriptionId: apiKeys.subscriptionId,
  name: apiKeys.name,
  remark: apiKeys.remark,
  expiresAt: apiKeys.expiresAt,
  rpmLimit: apiKeys.rpmLimit,
  tpmLimit: apiKeys.tpmLimit,
  dailySpendLimit: apiKeys.dailySpendLimit,
  allowPaygFallback: apiKeys.allowPaygFallback,
  status: apiKeys.status,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
} as const;

const APP_COLUMNS = {
  id: apps.id,
  appId: apps.appId,
  userId: apps.userId,
  clientId: apps.clientId,
  name: apps.name,
  description: apps.description,
  subscriptionId: apps.subscriptionId,
  scope: apps.scope,
  status: apps.status,
  createdAt: apps.createdAt,
  rotatedAt: apps.rotatedAt,
} as const;

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

export function createPostgresAccountStore(): AccountStorePort {
  return {
    // ---------------- 用户 ----------------
    async insertLocalUser(db, input) {
      try {
        const rows = await db
          .insert(users)
          .values({
            issuer: 'local',
            subject: input.email,
            identityProvider: 'local',
            email: input.email,
            displayName: input.displayName,
          })
          .returning(USER_COLUMNS);
        const user = rows[0];
        if (user === undefined) throw new Error('insertLocalUser returning empty');
        return { status: 'created', user };
      } catch (error) {
        // 权威约束:users_local_email_uq / users_issuer_subject_uq(并发兜底,v1 语义化翻译)
        if (isUniqueViolation(error)) return { status: 'email_taken' };
        throw error;
      }
    },

    async insertOAuthUser(db, input) {
      try {
        const rows = await db
          .insert(users)
          .values({
            issuer: input.issuer,
            subject: input.subject,
            identityProvider: input.issuer.slice(0, 16),
            email: input.email,
            displayName: input.displayName,
          })
          .returning(USER_COLUMNS);
        const user = rows[0];
        if (user === undefined) throw new Error('insertOAuthUser returning empty');
        return { status: 'created', user };
      } catch (error) {
        if (isUniqueViolation(error)) return { status: 'exists' };
        throw error;
      }
    },

    async findUserByEmail(db, email) {
      const rows = await db
        .select(USER_COLUMNS)
        .from(users)
        .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findUserById(db, userId) {
      const rows = await db.select(USER_COLUMNS).from(users).where(eq(users.id, userId)).limit(1);
      return rows[0] ?? null;
    },

    async findOAuthUser(db, issuer, subject) {
      const rows = await db
        .select(USER_COLUMNS)
        .from(users)
        .where(and(eq(users.issuer, issuer), eq(users.subject, subject)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getUserProfile(db, userId) {
      const rows = await db
        .select({ ...USER_COLUMNS, rateCardName: rateCards.name })
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateUser(db, { userId, patch, advanceSessionAnchor }) {
      const set: Record<string, unknown> = { updatedAt: nowSql };
      if (patch.displayName !== undefined) set.displayName = patch.displayName;
      if (patch.email !== undefined) set.email = patch.email;
      if (patch.rateCardId !== undefined) set.rateCardId = patch.rateCardId;
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.freezeReason !== undefined) set.freezeReason = patch.freezeReason;
      if (patch.rpmLimit !== undefined) set.rpmLimit = patch.rpmLimit;
      if (patch.tpmLimit !== undefined) set.tpmLimit = patch.tpmLimit;
      if (patch.dailySpendLimit !== undefined) set.dailySpendLimit = patch.dailySpendLimit;
      if (patch.isEnterprise !== undefined) set.isEnterprise = patch.isEnterprise;
      // email 变更 = 身份事实变更:同语句推进会话失效线(v1 单语句原子语义,拆两条开旧会话存活窗口)
      if (advanceSessionAnchor) set.sessionInvalidBefore = nowSql;
      const rows = await db.update(users).set(set).where(eq(users.id, userId)).returning(USER_COLUMNS);
      return rows[0] ?? null;
    },

    async userExists(db, userId) {
      const rows = await db.select({ one: sql<number>`1` }).from(users).where(eq(users.id, userId)).limit(1);
      return rows.length > 0;
    },

    async userIsEnterprise(db, userId) {
      const rows = await db
        .select({ isEnterprise: users.isEnterprise })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.isEnterprise === true;
    },

    async userRateCardBinding(db, userId) {
      const rows = await db
        .select({ rateCardId: users.rateCardId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.rateCardId ?? null;
    },

    async rateCardUsable(db, rateCardId) {
      const rows = await db
        .select({ status: rateCards.status })
        .from(rateCards)
        .where(eq(rateCards.id, rateCardId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return { status: 'missing' };
      return row.status === 0 ? { status: 'ok' } : { status: 'disabled' };
    },

    async listUsers(db, input) {
      const filters = [
        input.q
          ? or(
              ilike(users.subject, likePattern(input.q)),
              ilike(users.email, likePattern(input.q)),
              ilike(users.displayName, likePattern(input.q)),
            )
          : undefined,
        input.status !== undefined ? eq(users.status, input.status) : undefined,
        input.enterprise !== undefined ? eq(users.isEnterprise, input.enterprise) : undefined,
      ].filter((f) => f !== undefined);
      const where = filters.length > 0 ? and(...filters) : undefined;
      const sortColumns = {
        id: users.id,
        subject: users.subject,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      } as const;
      const column = sortColumns[input.sort.field as keyof typeof sortColumns] ?? users.id;
      const orderBy = [input.sort.order === 'asc' ? asc(column) : desc(column), desc(users.id)];
      const offset = (input.page - 1) * input.limit;
      const [rows, totalRows] = await Promise.all([
        db.select(USER_COLUMNS).from(users).where(where).orderBy(...orderBy).limit(input.limit).offset(offset),
        db.select({ value: count() }).from(users).where(where),
      ]);
      return { rows, total: totalRows[0]?.value ?? 0 };
    },

    // ---------------- API Key ----------------
    async insertKey(db, input) {
      const rows = await db
        .insert(apiKeys)
        .values({
          keyHash: input.keyHash,
          keyPreview: input.keyPreview,
          userId: input.userId,
          subscriptionId: input.subscriptionId,
          name: input.name,
          remark: input.remark,
          expiresAt: input.expiresAt,
          rpmLimit: input.rpmLimit,
          tpmLimit: input.tpmLimit,
          dailySpendLimit: input.dailySpendLimit,
          allowPaygFallback: input.allowPaygFallback,
        })
        .returning(KEY_COLUMNS);
      const row = rows[0];
      if (row === undefined) throw new Error('insertKey returning empty');
      return row;
    },

    async listKeysByUser(db, input) {
      const offset = (input.page - 1) * input.limit;
      const [rows, totalRows] = await Promise.all([
        db
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .where(eq(apiKeys.userId, input.userId))
          .orderBy(desc(apiKeys.id))
          .limit(input.limit)
          .offset(offset),
        db.select({ value: count() }).from(apiKeys).where(eq(apiKeys.userId, input.userId)),
      ]);
      return { rows, total: totalRows[0]?.value ?? 0 };
    },

    async findOwnedKey(db, { userId, keyId }) {
      const rows = await db
        .select(KEY_COLUMNS)
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async patchKey(db, { userId, keyId, patch }) {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.remark !== undefined) set.remark = patch.remark;
      if (patch.rpmLimit !== undefined) set.rpmLimit = patch.rpmLimit;
      if (patch.tpmLimit !== undefined) set.tpmLimit = patch.tpmLimit;
      if (patch.dailySpendLimit !== undefined) set.dailySpendLimit = patch.dailySpendLimit;
      if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
      const rows = await db
        .update(apiKeys)
        .set(set)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), eq(apiKeys.status, 0)))
        .returning(KEY_COLUMNS);
      return rows[0] ?? null;
    },

    async revokeKey(db, { userId, keyId }) {
      const rows = await db
        .update(apiKeys)
        .set({ status: 1, revokedAt: nowSql })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), eq(apiKeys.status, 0)))
        .returning(KEY_COLUMNS);
      return rows[0] ?? null;
    },

    async listAdminKeys(db, input) {
      const filters = [
        input.q
          ? or(
              ilike(apiKeys.name, likePattern(input.q)),
              ilike(apiKeys.keyPreview, likePattern(input.q)),
              ilike(users.email, likePattern(input.q)),
              ilike(users.displayName, likePattern(input.q)),
            )
          : undefined,
        input.userId !== undefined ? eq(apiKeys.userId, input.userId) : undefined,
        input.status !== undefined ? eq(apiKeys.status, input.status) : undefined,
      ].filter((f) => f !== undefined);
      const where = filters.length > 0 ? and(...filters) : undefined;
      const sortColumns = {
        id: apiKeys.id,
        name: apiKeys.name,
        status: apiKeys.status,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      } as const;
      const column = sortColumns[input.sort.field as keyof typeof sortColumns] ?? apiKeys.id;
      const orderBy = [input.sort.order === 'asc' ? asc(column) : desc(column), desc(apiKeys.id)];
      const offset = (input.page - 1) * input.limit;
      const [rows, totalRows] = await Promise.all([
        db
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.userId, users.id))
          .where(where)
          .orderBy(...orderBy)
          .limit(input.limit)
          .offset(offset),
        db
          .select({ value: count() })
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.userId, users.id))
          .where(where),
      ]);
      return { rows, total: totalRows[0]?.value ?? 0 };
    },

    async adminPatchKey(db, { keyId, patch }) {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.remark !== undefined) set.remark = patch.remark;
      if (patch.rpmLimit !== undefined) set.rpmLimit = patch.rpmLimit;
      if (patch.tpmLimit !== undefined) set.tpmLimit = patch.tpmLimit;
      if (patch.dailySpendLimit !== undefined) set.dailySpendLimit = patch.dailySpendLimit;
      if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
      if (patch.status !== undefined) set.status = patch.status;
      const rows = await db.update(apiKeys).set(set).where(eq(apiKeys.id, keyId)).returning(KEY_COLUMNS);
      return rows[0] ?? null;
    },

    async findActiveKeyByKeyHash(db, keyHash) {
      // 单查询守卫:key 在用 + 属主在用 + 未过期(clock),一次取回鉴权与限额全集(v1 语义)
      const rows = await db
        .select({
          keyId: apiKeys.id,
          userId: apiKeys.userId,
          subscriptionId: apiKeys.subscriptionId,
          rpmLimit: apiKeys.rpmLimit,
          tpmLimit: apiKeys.tpmLimit,
          dailySpendLimit: apiKeys.dailySpendLimit,
          allowPaygFallback: apiKeys.allowPaygFallback,
          userRpmLimit: users.rpmLimit,
          userTpmLimit: users.tpmLimit,
        })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(
          and(
            eq(apiKeys.keyHash, keyHash),
            eq(apiKeys.status, 0),
            eq(users.status, 0),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, nowSql)),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async rebindSubscription(db, { fromSubscriptionId, toSubscriptionId }) {
      const [keyRows, appRows] = await Promise.all([
        db
          .update(apiKeys)
          .set({ subscriptionId: toSubscriptionId })
          .where(eq(apiKeys.subscriptionId, fromSubscriptionId))
          .returning({ id: apiKeys.id }),
        db
          .update(apps)
          .set({ subscriptionId: toSubscriptionId })
          .where(eq(apps.subscriptionId, fromSubscriptionId))
          .returning({ id: apps.id }),
      ]);
      return { keys: keyRows.length, apps: appRows.length };
    },

    // ---------------- Application ----------------
    async insertApp(db, input) {
      const rows = await db
        .insert(apps)
        .values({
          appId: input.appId,
          userId: input.userId,
          clientId: input.clientId,
          clientSecretHash: input.clientSecretHash,
          name: input.name,
          description: input.description,
          subscriptionId: input.subscriptionId,
          scope:
            input.scope === null
              ? null
              : { ...input.scope, models: input.scope.models ? [...input.scope.models] : undefined },
        })
        .returning(APP_COLUMNS);
      const row = rows[0];
      if (row === undefined) throw new Error('insertApp returning empty');
      return row;
    },

    async listAppsByUser(db, input) {
      const offset = (input.page - 1) * input.limit;
      const [rows, totalRows] = await Promise.all([
        db
          .select(APP_COLUMNS)
          .from(apps)
          .where(eq(apps.userId, input.userId))
          .orderBy(desc(apps.id))
          .limit(input.limit)
          .offset(offset),
        db.select({ value: count() }).from(apps).where(eq(apps.userId, input.userId)),
      ]);
      return { rows, total: totalRows[0]?.value ?? 0 };
    },

    async findOwnedApp(db, { userId, appId }) {
      const rows = await db
        .select(APP_COLUMNS)
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async disableApp(db, { userId, appId }) {
      const rows = await db
        .update(apps)
        .set({ status: 1 })
        .where(and(eq(apps.id, appId), eq(apps.userId, userId), eq(apps.status, 0)))
        .returning(APP_COLUMNS);
      return rows[0] ?? null;
    },

    async rotateAppSecret(db, { userId, appId, clientSecretHash }) {
      // 先 FOR UPDATE 行锁再更新:防并发轮换产生孤儿 secret(v1 两步语义)
      const locked = await db
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.userId, userId), eq(apps.status, 0)))
        .for('update')
        .limit(1);
      if (locked.length === 0) return null;
      const rows = await db
        .update(apps)
        .set({ clientSecretHash, rotatedAt: nowSql })
        .where(and(eq(apps.id, appId), eq(apps.status, 0)))
        .returning(APP_COLUMNS);
      return rows[0] ?? null;
    },

    async findActiveAppByAppId(db, appId) {
      const rows = await db
        .select({
          id: apps.id,
          appId: apps.appId,
          userId: apps.userId,
          scope: apps.scope,
          subscriptionId: apps.subscriptionId,
        })
        .from(apps)
        .innerJoin(users, eq(apps.userId, users.id))
        .where(and(eq(apps.appId, appId), eq(apps.status, 0), eq(users.status, 0)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findActiveAppByClient(db, { clientId, clientSecretHash }) {
      const rows = await db
        .select({
          id: apps.id,
          appId: apps.appId,
          userId: apps.userId,
          scope: apps.scope,
          subscriptionId: apps.subscriptionId,
        })
        .from(apps)
        .innerJoin(users, eq(apps.userId, users.id))
        .where(
          and(
            eq(apps.clientId, clientId),
            eq(apps.clientSecretHash, clientSecretHash),
            eq(apps.status, 0),
            eq(users.status, 0),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    // ---------------- 组织/成员/邀请 ----------------
    async insertOrgWithOwner(db, { name, ownerUserId }) {
      return db.transaction(async (tx) => {
        const orgRows = await tx
          .insert(organizations)
          .values({ name, ownerUserId })
          .returning({ id: organizations.id, createdAt: organizations.createdAt, updatedAt: organizations.updatedAt, name: organizations.name, ownerUserId: organizations.ownerUserId });
        const org = orgRows[0];
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
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)))
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
          and(eq(orgInvitations.orgId, orgId), eq(orgInvitations.status, 0), gt(orgInvitations.expiresAt, nowSql)),
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
      const row = rows[0];
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
        .where(and(eq(orgInvitations.orgId, orgId), eq(orgInvitations.status, 0), gt(orgInvitations.expiresAt, nowSql)))
        .orderBy(desc(orgInvitations.id));
    },

    async revokeInvitation(db, { orgId, invitationId }) {
      const rows = await db
        .update(orgInvitations)
        .set({ status: 2, updatedAt: nowSql })
        .where(
          and(eq(orgInvitations.id, invitationId), eq(orgInvitations.orgId, orgId), eq(orgInvitations.status, 0)),
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
        .where(and(eq(orgInvitations.id, invitationId), eq(orgInvitations.status, 0), gt(orgInvitations.expiresAt, nowSql)))
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
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)))
        .returning(MEMBER_COLUMNS);
      return rows[0] ?? null;
    },

    async removeMember(db, { orgId, userId }) {
      const rows = await db
        .update(orgMembers)
        .set({ status: 1, updatedAt: nowSql })
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)))
        .returning({ id: orgMembers.id });
      return rows.length > 0;
    },

    async findUsableSubscription(db, { userId, subscriptionId }) {
      const rows = await db
        .select({ userId: userSubscriptions.userId, orgId: userSubscriptions.orgId })
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.id, subscriptionId), eq(userSubscriptions.status, 0), gt(userSubscriptions.endAt, nowSql)))
        .limit(1);
      const sub = rows[0];
      if (sub === undefined) return null;
      if (sub.userId === userId) return { userId: sub.userId, orgId: sub.orgId };
      // 组织订阅:须为该组织 active 成员(v1 守卫口径)
      if (sub.orgId === null) return null;
      const member = await db
        .select({ id: orgMembers.id })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, sub.orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)))
        .limit(1);
      return member.length > 0 ? { userId: sub.userId, orgId: sub.orgId } : null;
    },

    async memberLimits(db, { orgId, userId }) {
      const rows = await db
        .select({ dailySpendLimit: orgMembers.dailySpendLimit, monthlyQuota: orgMembers.monthlyQuota })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },

    // ---------------- 推荐/拉新参数 ----------------
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
      const rows = await db.select().from(marketingSettings).where(eq(marketingSettings.id, 1)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        return {
          signupGiftAmount: '0',
          referralSignupBonus: '0',
          referralCommissionRate: '0',
          updatedBy: null,
          updatedAt: new Date(0),
        };
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
      if (patch.referralCommissionRate !== undefined) set.referralCommissionRate = patch.referralCommissionRate;
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
      // 自联两次 users(邀请人/被邀人);q 命中任一侧账号(ilike 走转义)
      const filter = input.q
        ? sql`where i.email ilike ${likePattern(input.q)} or i.display_name ilike ${likePattern(input.q)}
                or e.email ilike ${likePattern(input.q)} or e.display_name ilike ${likePattern(input.q)}`
        : sql``;
      const rows = await db.execute(sql`
        select r.id, r.inviter_user_id, r.invitee_user_id, r.status, r.created_at,
               i.email as inviter_email, i.display_name as inviter_display_name,
               e.email as invitee_email, e.display_name as invitee_display_name
        from referrals r
        join users i on i.id = r.inviter_user_id
        join users e on e.id = r.invitee_user_id
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
      const list = (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as number,
        inviterUserId: r.inviter_user_id as number,
        inviterEmail: (r.inviter_email as string | null) ?? null,
        inviterDisplayName: (r.inviter_display_name as string | null) ?? null,
        inviteeUserId: r.invitee_user_id as number,
        inviteeEmail: (r.invitee_email as string | null) ?? null,
        inviteeDisplayName: (r.invitee_display_name as string | null) ?? null,
        status: r.status as number,
        createdAt: r.created_at as Date,
      }));
      return { rows: list, total: (totalRows.rows[0] as { value: number } | undefined)?.value ?? 0 };
    },

    async setReferralRelationStatus(db, { relationId, status }) {
      const rows = await db
        .update(referrals)
        .set({ status })
        .where(eq(referrals.id, relationId))
        .returning({ id: referrals.id });
      if (rows.length === 0) return null;
      const view = await db.execute(sql`
        select r.id, r.inviter_user_id, r.invitee_user_id, r.status, r.created_at,
               i.email as inviter_email, i.display_name as inviter_display_name,
               e.email as invitee_email, e.display_name as invitee_display_name
        from referrals r
        join users i on i.id = r.inviter_user_id
        join users e on e.id = r.invitee_user_id
        where r.id = ${relationId}
      `);
      const r = (view.rows[0] ?? null) as Record<string, unknown> | null;
      if (r === null) return null;
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
    },
  };
}
