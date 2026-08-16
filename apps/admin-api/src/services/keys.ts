import { eq } from 'drizzle-orm';
import { apiKeys } from '@ai-gateway/db/schema';
import { buildList, countAll, HttpError, invalidateKeyAuthCache, listQuerySchema, paginateQuery, recordAudit } from '@ai-gateway/http';
import { z } from 'zod';
import { users } from '@ai-gateway/db/schema';
import type { AdminServices } from './index.js';

/**
 * 管理员 Key 服务（限流配置视角）。
 * 与 client-api 的 keys（用户自助）区别：不限 userId，改限流/吊销后主动清
 * gateway 鉴权缓存（auth:key:{hash}）立即生效。明文 Key 永不回显。
 */

export interface ApiKeyPatch {
  name?: string;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailySpendLimit?: number | null;
  status?: number;
}

export async function updateApiKey(
  s: AdminServices,
  id: number,
  patch: ApiKeyPatch,
  adminId: number,
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.rpmLimit !== undefined) update.rpmLimit = patch.rpmLimit;
  if (patch.tpmLimit !== undefined) update.tpmLimit = patch.tpmLimit;
  if (patch.dailySpendLimit !== undefined) update.dailySpendLimit = patch.dailySpendLimit;
  if (patch.status !== undefined) update.status = patch.status;

  const [updated] = await s.db
    .update(apiKeys)
    .set(update)
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });
  if (!updated) throw new HttpError('API_KEY_NOT_FOUND', 'Key 不存在');

  // 立即生效：清 gateway 鉴权缓存（无需等 60s TTL）
  await invalidateKeyAuthCache(s.redis, [updated.keyHash]);

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'api_key.update_limit',
    targetType: 'api_key',
    targetId: id,
    detail: { ...patch },
  });
}

export async function listApiKeys(s: AdminServices, q: z.infer<typeof keyListQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [apiKeys.name, apiKeys.keyPreview, users.email, users.displayName],
    conditions: [
      q.userId ? eq(apiKeys.userId, q.userId) : undefined,
      q.status !== undefined ? eq(apiKeys.status, q.status) : undefined,
    ],
    sort: {
      by: { id: apiKeys.id, name: apiKeys.name, status: apiKeys.status, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt },
      fallback: 'createdAt',
      tiebreaker: apiKeys.id,
    },
  });

  return paginateQuery(
    page,
    s.db
      .select({
        id: apiKeys.id,
        keyPreview: apiKeys.keyPreview,
        name: apiKeys.name,
        remark: apiKeys.remark,
        subscriptionId: apiKeys.subscriptionId,
        userId: apiKeys.userId,
        userEmail: users.email,
        userDisplayName: users.displayName,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        dailySpendLimit: apiKeys.dailySpendLimit,
        status: apiKeys.status,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, apiKeys, where, [{ table: users, on: eq(apiKeys.userId, users.id) }]),
  );
}

export const keyListQuerySchema = listQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
});
