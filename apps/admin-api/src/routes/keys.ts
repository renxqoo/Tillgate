import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { apiKeys, users } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { HttpError, invalidateKeyAuthCache, jsonBody, limitOffset, paginateQuery, paginationQuerySchema, parsePagination, query, recordAudit } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

/**
 * 管理员 Key 管理（限流配置视角，api-contract §4.x）。
 *
 * 与 client-api 的 keys（用户自助）区别：
 *   - 不限 userId（管理员可看所有用户的 Key）
 *   - 改限流/吊销后主动清 gateway 鉴权缓存（auth:key:{hash}）立即生效
 *
 * 安全：明文 Key 永不回显，只返回 keyPreview（脱敏，由创建时写入）。
 */

const keyListQuerySchema = paginationQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
});

const keyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  /** RPM 限流，null=不限流（继承用户/全局） */
  rpmLimit: z.number().int().min(1).nullable().optional(),
  /** TPM 限流，null=不限流 */
  tpmLimit: z.number().int().min(1).nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

export function keyAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表（关联用户，脱敏 preview）
    .get('/', query(keyListQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [];
      if (q.userId) conds.push(eq(apiKeys.userId, q.userId));
      if (q.status !== undefined) conds.push(eq(apiKeys.status, q.status));
      const where = conds.length > 0 ? and(...conds) : undefined;

      const result = await paginateQuery(
        p,
        s.db
          .select({
            id: apiKeys.id,
            keyPreview: apiKeys.keyPreview,
            name: apiKeys.name,
            remark: apiKeys.remark,
            userId: apiKeys.userId,
            userEmail: users.email,
            userDisplayName: users.displayName,
            rpmLimit: apiKeys.rpmLimit,
            tpmLimit: apiKeys.tpmLimit,
            status: apiKeys.status,
            lastUsedAt: apiKeys.lastUsedAt,
            createdAt: apiKeys.createdAt,
          })
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.userId, users.id))
          .where(where)
          .orderBy(desc(apiKeys.createdAt))
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(apiKeys).where(where),
      );
      return c.json(result);
    })

    // 更新限流（+ name/status），改后清 auth:key 缓存立即生效
    .patch('/:id', jsonBody(keyUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');

      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
      if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
      if (body.status !== undefined) update.status = body.status;

      const [updated] = await s.db
        .update(apiKeys)
        .set(update)
        .where(eq(apiKeys.id, id))
        .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });
      if (!updated) throw new HttpError(404, 'API_KEY_NOT_FOUND', 'Key 不存在');

      // 立即生效：清 gateway 鉴权缓存（无需等 60s TTL）
      await invalidateKeyAuthCache(s.redis, [updated.keyHash]);

      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'api_key.update_limit',
        targetType: 'api_key',
        targetId: id,
        detail: body,
      });
      return c.json({ ok: true });
    });
}
