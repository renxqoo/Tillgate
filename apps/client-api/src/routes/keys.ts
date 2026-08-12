import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { apiKeys } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody, query } from '../lib/validation.js';
import { z } from 'zod';
import { generateApiKey, sha256Hex, maskKey } from '../lib/secrets.js';
import { recordAudit } from '@ai-gateway/billing';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import type { ClientEnv } from '@ai-gateway/identity';

/**
 * 用户面板：虚拟 Key 管理（api-contract §4.2）。
 *
 *   - GET /api/keys：自己的 Key 列表（只显示脱敏预览，不回显明文）
 *   - POST /api/keys：创建，明文 Key 仅在响应中出现一次（落库的是 SHA-256 哈希）
 *   - PATCH /api/keys/:id：改名/限流/过期调整（不可改 Key 本身）
 *   - DELETE /api/keys/:id：吊销（立即失效）
 *
 * 安全（data-model §3.3）：
 *   - 明文 Key 不落库，只存 key_hash + key_preview
 *   - 所有操作限定 user_id = session.userId（防越权）
 *
 * 拆分后：用户自助操作的审计 adminId 传 null（非管理员动作），仅记录 action 留痕。
 */

const keyCreateSchema = z.object({
  name: z.string().min(1).max(64),
  remark: z.string().max(255).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
});

const keyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  remark: z.string().max(255).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  rpmLimit: z.number().int().min(1).nullable().optional(),
  tpmLimit: z.number().int().min(1).nullable().optional(),
});

export function keyRoutes(db: Db): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 列表
    .get('/api/keys', query(paginationQuerySchema), async (c) => {
      const session = c.get('session');
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: apiKeys.id,
            keyPreview: apiKeys.keyPreview,
            name: apiKeys.name,
            remark: apiKeys.remark,
            expiresAt: apiKeys.expiresAt,
            rpmLimit: apiKeys.rpmLimit,
            tpmLimit: apiKeys.tpmLimit,
            status: apiKeys.status,
            lastUsedAt: apiKeys.lastUsedAt,
            createdAt: apiKeys.createdAt,
          })
          .from(apiKeys)
          .where(eq(apiKeys.userId, session.userId))
          .orderBy(desc(apiKeys.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(apiKeys).where(eq(apiKeys.userId, session.userId)),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 创建（明文 Key 仅此一次回显）
    .post('/api/keys', jsonBody(keyCreateSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      const plaintext = generateApiKey();
      const keyHash = sha256Hex(plaintext);
      const [created] = await db
        .insert(apiKeys)
        .values({
          keyHash,
          keyPreview: maskKey(plaintext),
          userId: session.userId,
          name: body.name,
          remark: body.remark ?? null,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          rpmLimit: body.rpmLimit ?? null,
          tpmLimit: body.tpmLimit ?? null,
          status: 0,
        })
        .returning({ id: apiKeys.id, name: apiKeys.name });
      await recordAudit(db, {
        adminId: null,
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: created!.id,
      });
      // 明文 key 只在此响应中下发
      return c.json({ ...created, key: plaintext }, 201);
    })

    // 更新（不可改 Key 本身）
    .patch('/api/keys/:id', jsonBody(keyUpdateSchema), async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const update: Record<string, unknown> = {};
      if (body.name !== undefined) update.name = body.name;
      if (body.remark !== undefined) update.remark = body.remark;
      if (body.expiresAt !== undefined) update.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
      if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
      const [updated] = await db
        .update(apiKeys)
        .set(update)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, session.userId))) // 限定自己的 Key
        .returning();
      if (!updated) return c.json({ error: 'Key 不存在或无权操作' }, 404);
      return c.json(updated);
    })

    // 吊销（立即失效）
    .delete('/api/keys/:id', async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
      const [revoked] = await db
        .update(apiKeys)
        .set({ status: 1, revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, session.userId), eq(apiKeys.status, 0)))
        .returning({ id: apiKeys.id });
      if (!revoked) return c.json({ error: 'Key 不存在、无权操作或已吊销' }, 404);
      await recordAudit(db, {
        adminId: null,
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: id,
      });
      // 注意：吊销后需清 gateway 侧 Redis 鉴权缓存（KeyAuthCache）才即时生效；
      // gateway 与 client-api 共享同一 Redis，可通过 Redis pub/sub 或 TTL（60s）自然过期。
      // 一期靠 TTL 自然过期（60s 内仍可用，可接受）。
      return c.json({ ok: true });
    });
}
