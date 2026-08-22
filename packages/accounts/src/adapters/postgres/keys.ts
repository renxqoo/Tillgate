/**
 * API Key 聚合 SQL:生命周期 CAs、管理面、网关鉴权读模型、订阅换绑。
 * 投影结构性排除 keyHash(明文口径见 domain/credentials)。
 */
import { and, asc, count, desc, eq, gt, ilike, isNull, or } from 'drizzle-orm';
import { apiKeys, apps, users } from '@tokenlens/db';
import type { AccountStorePort } from '../../ports/account-store.js';
import { likePattern, nowSql } from './shared.js';

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

export const keyQueries: Pick<
  AccountStorePort,
  | 'insertKey'
  | 'listKeysByUser'
  | 'findOwnedKey'
  | 'patchKey'
  | 'revokeKey'
  | 'listAdminKeys'
  | 'adminPatchKey'
  | 'findActiveKeyByKeyHash'
  | 'rebindSubscription'
> = {
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
    const rows = await db
      .update(apiKeys)
      .set(set)
      .where(eq(apiKeys.id, keyId))
      .returning(KEY_COLUMNS);
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
};
