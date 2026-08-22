/**
 * Application 聚合 SQL:凭证 CRUD 与鉴权读模型。
 * 投影结构性排除 clientSecretHash;轮换走 FOR UPDATE 行锁。
 */
import { and, count, desc, eq } from 'drizzle-orm';
import { apps, users } from '@tokenlens/db';
import type { AccountStorePort } from '../../ports/account-store.js';
import { nowSql } from './shared.js';

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

const ACTIVE_APP_COLUMNS = {
  id: apps.id,
  appId: apps.appId,
  userId: apps.userId,
  scope: apps.scope,
  subscriptionId: apps.subscriptionId,
} as const;

export const appQueries: Pick<
  AccountStorePort,
  'insertApp' | 'listAppsByUser' | 'findOwnedApp' | 'disableApp' | 'rotateAppSecret' | 'findActiveAppByAppId' | 'findActiveAppByClient'
> = {
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
            : {
                ...input.scope,
                models: input.scope.models ? [...input.scope.models] : undefined,
              },
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
      .select(ACTIVE_APP_COLUMNS)
      .from(apps)
      .innerJoin(users, eq(apps.userId, users.id))
      .where(and(eq(apps.appId, appId), eq(apps.status, 0), eq(users.status, 0)))
      .limit(1);
    return rows[0] ?? null;
  },

  async findActiveAppByClient(db, { clientId, clientSecretHash }) {
    const rows = await db
      .select(ACTIVE_APP_COLUMNS)
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
};
