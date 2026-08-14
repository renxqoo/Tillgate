import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { apps } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  appStatusCache,
  generateClientId,
  generateClientSecret,
  HttpError,
  jsonBody,
  limitOffset,
  paginateQuery,
  paginationQuerySchema,
  parsePagination,
  query,
  recordAudit,
  sha256Hex,
} from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：应用（App）管理（api-contract §4.2）。
 *
 *   - GET /：应用列表
 *   - POST /：创建，返回 client_id + client_secret（secret 仅此一次）
 *   - DELETE /:id：禁用应用（清 gateway Redis App 状态缓存 → 已签发 JWT 立即失效）
 *   - POST /:id/rotate-secret：轮换 secret（旧 secret 不能再换新 JWT；不影响已签发 JWT）
 *
 * 安全（data-model §3.2）：
 *   - client_secret 只存 SHA-256 哈希，明文仅创建/轮换时下发
 *   - 轮换使用事务 + FOR UPDATE 行锁，防并发 rotate 竞争
 */

const appCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
  /** 计费来源：NULL=余额；非空=扣该订阅额度。 */
  subscriptionId: z.number().int().positive().nullable().optional(),
  scope: z.object({
    models: z.array(z.string()).optional(),
    rpm: z.number().int().min(1).optional(),
    tpm: z.number().int().min(1).optional(),
  }).optional(),
});

export function appRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 列表
    .get('/', query(paginationQuerySchema), async (c) => {
      const session = c.get('session');
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const where = eq(apps.userId, session.userId);
      const result = await paginateQuery(
        p,
        s.db
          .select({
            id: apps.id,
            appId: apps.appId,
            clientId: apps.clientId,
            name: apps.name,
            description: apps.description,
            subscriptionId: apps.subscriptionId,
            scope: apps.scope,
            status: apps.status,
            createdAt: apps.createdAt,
            rotatedAt: apps.rotatedAt,
          })
          .from(apps)
          .where(where)
          .orderBy(desc(apps.createdAt))
          .limit(limit)
          .offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(apps).where(where),
      );
      return c.json(result);
    })

    // 创建（client_secret 仅此一次回显）
    .post('/', jsonBody(appCreateSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      const clientId = generateClientId();
      const clientSecret = generateClientSecret();
      const [created] = await s.db
        .insert(apps)
        .values({
          appId: clientId, // 复用 client_id 作为对外 app_id（一期简化，二者同值）
          userId: session.userId,
          clientId,
          clientSecretHash: sha256Hex(clientSecret),
          name: body.name,
          description: body.description ?? null,
          subscriptionId: body.subscriptionId ?? null,
          scope: body.scope ?? null,
          status: 0,
        })
        .returning({ id: apps.id, appId: apps.appId, clientId: apps.clientId, name: apps.name });
      await recordAudit(s.db, {
        actor: 'user',
        action: 'app.create',
        targetType: 'app',
        targetId: created!.id,
      });
      // client_secret 明文仅此一次
      return c.json({ ...created, clientSecret }, 201);
    })

    // 禁用应用（已签发 JWT 立即失效）
    .delete('/:id', async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
      const [disabled] = await s.db
        .update(apps)
        .set({ status: 1 })
        .where(and(eq(apps.id, id), eq(apps.userId, session.userId), eq(apps.status, 0)))
        .returning({ id: apps.id, appId: apps.appId });
      if (!disabled) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在、无权操作或已禁用');
      await recordAudit(s.db, {
        actor: 'user',
        action: 'app.disable',
        targetType: 'app',
        targetId: id,
        detail: { appId: disabled.appId },
      });
      // 清 gateway 侧 App 状态缓存（app_status:{id}）→ 已签发 JWT 立即失效。
      // Redis 不可用时静默降级：靠 TTL 60s 兜底（gateway 下次查 DB 拿到 status=1）
      await s.redis.del(appStatusCache(id)).catch(() => {});
      return c.json({ ok: true });
    })

    // 轮换 secret（旧 secret 不能换新 JWT；不影响已签发 JWT）
    .post('/:id/rotate-secret', async (c) => {
      const session = c.get('session');
      const id = Number(c.req.param('id'));
      const newSecret = generateClientSecret();
      // 事务 + FOR UPDATE 行锁，防并发 rotate 竞争（两请求各返回 secret，后者覆盖前者）
      const [updated] = await s.db.transaction(async (tx) => {
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
      if (!updated) throw new HttpError(404, 'APP_NOT_FOUND', '应用不存在或无权操作');
      await recordAudit(s.db, {
        actor: 'user',
        action: 'app.rotate_secret',
        targetType: 'app',
        targetId: id,
      });
      // 新 secret 明文仅此一次
      return c.json({ ok: true, clientSecret: newSecret });
    });
}
