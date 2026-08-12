import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { apps } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody, query } from '../lib/validation.js';
import { z } from 'zod';
import { generateClientId, generateClientSecret, sha256Hex } from '../lib/secrets.js';
import { recordAudit, getSharedRedis } from '@ai-gateway/billing';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import type { ClientEnv } from '@ai-gateway/identity';

/**
 * 用户面板：应用（App）管理（api-contract §4.2）。
 *
 *   - GET /api/apps：应用列表
 *   - POST /api/apps：创建，返回 client_id + client_secret（secret 仅此一次）
 *   - DELETE /api/apps/:id：禁用应用（清 gateway Redis App 状态缓存 → 已签发 JWT 立即失效）
 *   - POST /api/apps/:id/rotate-secret：轮换 secret（旧 secret 不能再换新 JWT；不影响已签发 JWT）
 *
 * 安全（data-model §3.2）：
 *   - client_secret 只存 SHA-256 哈希（client_secret_hash），明文仅创建/轮换时下发
 *   - 禁用 App 让所有已签发 JWT 立即失效（gateway 验签时查 App 状态缓存）
 *   - 轮换 secret 不撤销已签发 JWT（JWT 由网关密钥签发，与 secret 无关）
 */

const appCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  scope: z.object({
    models: z.array(z.string()).optional(),
    rpm: z.number().int().min(1).optional(),
    tpm: z.number().int().min(1).optional(),
  }).optional(),
});

export function appRoutes(db: Db): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 列表
    .get('/api/apps', query(paginationQuerySchema), async (c) => {
      const session = c.get('session');
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: apps.id,
            appId: apps.appId,
            clientId: apps.clientId,
            name: apps.name,
            description: apps.description,
            scope: apps.scope,
            status: apps.status,
            createdAt: apps.createdAt,
            rotatedAt: apps.rotatedAt,
          })
          .from(apps)
          .where(eq(apps.userId, session.userId))
          .orderBy(desc(apps.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(apps).where(eq(apps.userId, session.userId)),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 创建（client_secret 仅此一次回显）
    .post('/api/apps', jsonBody(appCreateSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      const clientId = generateClientId();
      const clientSecret = generateClientSecret();
      const [created] = await db
        .insert(apps)
        .values({
          appId: clientId, // 复用 client_id 作为对外 app_id（一期简化，二者同值）
          userId: session.userId,
          clientId,
          clientSecretHash: sha256Hex(clientSecret),
          name: body.name,
          description: body.description ?? null,
          scope: body.scope ?? null,
          status: 0,
        })
        .returning({ id: apps.id, appId: apps.appId, clientId: apps.clientId, name: apps.name });
      await recordAudit(db, {
        adminId: null,
        action: 'app.create',
        targetType: 'app',
        targetId: created!.id,
      });
      // client_secret 明文仅此一次
      return c.json({ ...created, clientSecret }, 201);
    })

    // 禁用应用（已签发 JWT 立即失效）
    .delete('/api/apps/:id', async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
      const [disabled] = await db
        .update(apps)
        .set({ status: 1 })
        .where(and(eq(apps.id, id), eq(apps.userId, session.userId), eq(apps.status, 0)))
        .returning({ id: apps.id, appId: apps.appId });
      if (!disabled) return c.json({ error: '应用不存在、无权操作或已禁用' }, 404);
      await recordAudit(db, {
        adminId: null,
        action: 'app.disable',
        targetType: 'app',
        targetId: id,
        detail: { appId: disabled.appId },
      });
      // G2 修复：清 gateway 侧 App 状态缓存（app_status:{id}）→ 已签发 JWT 立即失效。
      try {
        await getSharedRedis().del(`app_status:${id}`);
      } catch {
        // Redis 不可用：靠 TTL 60s 兜底（gateway 下次查 DB 拿到 status=1）
      }
      return c.json({ ok: true });
    })

    // 轮换 secret（旧 secret 不能换新 JWT；不影响已签发 JWT）
    .post('/api/apps/:id/rotate-secret', async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
      const newSecret = generateClientSecret();
      // A-2 修复：事务 + FOR UPDATE 行锁，防并发 rotate 竞争（两请求各返回 secret，后者覆盖前者）
      const [updated] = await db.transaction(async (tx) => {
        // 先锁行（FOR UPDATE），确保并发 rotate 串行化
        await tx.select({ id: apps.id }).from(apps)
          .where(and(eq(apps.id, id), eq(apps.userId, session.userId)))
          .for('update').limit(1);
        const [u] = await tx
          .update(apps)
          .set({ clientSecretHash: sha256Hex(newSecret), rotatedAt: new Date() })
          .where(and(eq(apps.id, id), eq(apps.userId, session.userId)))
          .returning({ id: apps.id });
        return [u];
      });
      if (!updated) return c.json({ error: '应用不存在或无权操作' }, 404);
      await recordAudit(db, {
        adminId: null,
        action: 'app.rotate_secret',
        targetType: 'app',
        targetId: id,
      });
      // 新 secret 明文仅此一次
      return c.json({ ok: true, clientSecret: newSecret });
    });
}
