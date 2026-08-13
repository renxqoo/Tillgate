import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { apiKeys, users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody, query } from '../lib/validation.js';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import { getAdminRedis } from '../lib/route-invalidation.js';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 管理员 Key 管理（限流配置视角，api-contract §4.x）。
 *
 * 与 client-api/keys.ts（用户自助）的区别：
 *   - 不限 userId（管理员可看所有用户的 Key）
 *   - 改限流后主动清 gateway 鉴权缓存（auth:key:{hash}）立即生效
 *     （client-api 改 key 限流仅靠 60s TTL 过期，此处修复该延迟遗留）
 *
 * 安全：明文 Key 永不回显，只返回 keyPreview（ag_****abcd 脱敏）。
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

export function keyAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表（关联用户，脱敏 preview）
    .get('/api/admin/keys', query(keyListQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [];
      if (q.userId) conds.push(eq(apiKeys.userId, q.userId));
      if (q.status !== undefined) conds.push(eq(apiKeys.status, q.status));
      const where = conds.length > 0 ? and(...conds) : undefined;
      const [rows, countRows] = await Promise.all([
        db
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
        db.select({ count: sql<number>`count(*)::int` }).from(apiKeys).where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 更新限流（+ name/status），改后清 auth:key 缓存立即生效
    .patch('/api/admin/keys/:id', jsonBody(keyUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const adminId = c.get('adminId');

      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
      if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
      if (body.status !== undefined) update.status = body.status;

      const [updated] = await db
        .update(apiKeys)
        .set(update)
        .where(eq(apiKeys.id, id))
        .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });
      if (!updated) return c.json({ error: 'Key 不存在' }, 404);

      // 立即生效：清 gateway 鉴权缓存（修复 client-api 改 key 限流 60s 延迟遗留）
      const redis = getAdminRedis();
      if (redis && updated.keyHash) {
        await redis.del(`auth:key:${updated.keyHash}`).catch(() => {});
      }

      await recordAudit(db, {
        adminId,
        action: 'api_key.update_limit',
        targetType: 'api_key',
        targetId: id,
        detail: body,
      });
      return c.json({ ok: true });
    });
}
