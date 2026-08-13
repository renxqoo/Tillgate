import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { providers } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { bumpRouteCache, HttpError, jsonBody, recordAudit } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

/**
 * 供应商管理（api-contract §4.6）。
 * 变更后 bump 路由缓存版本，gateway 检测版本变化后重建路由表。
 */

const providerCreateSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  protocol: z.string().optional(),
  status: z.number().optional(),
}).passthrough();

const providerUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  protocol: z.string().optional(),
  status: z.number().optional(),
}).passthrough();

export function providerAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    .get('/', async (c) => {
      const rows = await s.db.select().from(providers).orderBy(providers.id);
      return c.json({ list: rows, total: rows.length });
    })

    .post('/', jsonBody(providerCreateSchema), async (c) => {
      const body = c.req.valid('json');
      const [created] = await s.db
        .insert(providers)
        .values({
          name: body.name,
          protocol: body.protocol ?? 'openai_compatible',
          baseUrl: body.baseUrl,
          status: body.status ?? 0,
        })
        .returning();
      await bumpRouteCache(s.redis);
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'provider.create',
        targetType: 'provider',
        targetId: created!.id,
        detail: { name: body.name },
      });
      return c.json(created, 201);
    })

    .patch('/:id', jsonBody(providerUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name;
      if (body.baseUrl !== undefined) update.baseUrl = body.baseUrl;
      if (body.protocol !== undefined) update.protocol = body.protocol;
      if (body.status !== undefined) update.status = body.status;
      const [updated] = await s.db
        .update(providers)
        .set(update)
        .where(eq(providers.id, id))
        .returning();
      if (!updated) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '供应商不存在');
      await bumpRouteCache(s.redis);
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'provider.update',
        targetType: 'provider',
        targetId: id,
        detail: body,
      });
      return c.json(updated);
    })

    .delete('/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const [retired] = await s.db
        .update(providers)
        .set({ status: 1 })
        .where(eq(providers.id, id))
        .returning({ id: providers.id });
      if (!retired) throw new HttpError(404, 'PROVIDER_NOT_FOUND', '供应商不存在');
      await bumpRouteCache(s.redis);
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'provider.retire',
        targetType: 'provider',
        targetId: id,
      });
      return c.json({ ok: true });
    });
}
