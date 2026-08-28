/**
 * 用户聚合 SQL:建号(local/OAuth find-or-create)、资料、管理面列表/补丁、
 * 只读探针与换卡守卫。投影结构性排除 passwordHash。
 */
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { isUniqueViolation, rateCards, users } from '@tillgate/db';
import type { AccountStorePort } from '../../ports/account-store.js';
import { likePattern, nowSql } from './shared.js';

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
  isEnterprise: users.isEnterprise,
  freezeReason: users.freezeReason,
  rpmLimit: users.rpmLimit,
  tpmLimit: users.tpmLimit,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

export const userQueries: Pick<
  AccountStorePort,
  | 'insertLocalUser'
  | 'insertOAuthUser'
  | 'findUserByEmail'
  | 'findUserById'
  | 'findOAuthUser'
  | 'getUserProfile'
  | 'updateUser'
  | 'userExists'
  | 'userIsEnterprise'
  | 'userRateCardBinding'
  | 'rateCardUsable'
  | 'listUsers'
> = {
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
      const [user] = rows;
      if (user === undefined) throw new Error('insertLocalUser returning empty');
      return { status: 'created', user };
    } catch (error) {
      // 权威约束:users_local_email_uq / users_issuer_subject_uq(并发兜底)
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
      const [user] = rows;
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

  async updateUser(db, { userId, patch }) {
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
    // email 变更的会话失效唯一所有者是 identity:admin-patch-user 在同一事务内
    // 经 SessionInvalidationPort 推进 identity_session_anchors 吊销线(旧列已随 0090 退役)
    const rows = await db
      .update(users)
      .set(set)
      .where(eq(users.id, userId))
      .returning(USER_COLUMNS);
    return rows[0] ?? null;
  },

  async userExists(db, userId) {
    const rows = await db
      .select({ one: sql<number>`1` })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
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
    const [row] = rows;
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
      db
        .select({ ...USER_COLUMNS, rateCardName: rateCards.name })
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(offset),
      db.select({ value: count() }).from(users).where(where),
    ]);
    return { rows, total: totalRows[0]?.value ?? 0 };
  },
};
