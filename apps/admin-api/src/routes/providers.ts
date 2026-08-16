import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { providers } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  bumpRouteCache, HttpError, jsonBody, recordAudit, intParam,
  paginateQuery, query, listQuerySchema, buildList, countAll,
} from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import { SUPPORTED_PROTOCOLS } from '@ai-gateway/ai';
import type { AdminServices } from '../services/index.js';

/**
 * 供应商管理（api-contract §4.6）。
 * 变更后 bump 路由缓存版本，gateway 检测版本变化后重建路由表。
 */

/** 协议词表单一真相：ai 包适配器注册表键。非法值 400（错误语义分级：可预期拒绝 ≠ 异常） */
const protocolSchema = z
  .string()
  .max(32)
  .refine((v) => (SUPPORTED_PROTOCOLS as readonly string[]).includes(v), {
    message: `不支持的协议（可选: ${SUPPORTED_PROTOCOLS.join(', ')}）`,
  });

const providerCreateSchema = z.object({
  name: z.string().min(1).max(32),
  baseUrl: z.string().url().max(255),
  protocol: protocolSchema.optional(),
  status: z.number().int().min(0).max(1).optional(),
}).passthrough();

const providerUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  baseUrl: z.string().url().max(255).optional(),
  protocol: protocolSchema.optional(),
  status: z.number().int().min(0).max(1).optional(),
}).passthrough();

export function providerAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    .get('/', query(listQuerySchema), async (c) => {
      const input = c.req.valid('query');
      const { page, limit, offset, where, orderBy } = buildList(input, {
        search: [providers.name, providers.baseUrl],
        sort: {
          by: { id: providers.id, name: providers.name, status: providers.status, createdAt: providers.createdAt },
          fallback: 'createdAt',
          tiebreaker: providers.id,
        },
      });
      const result = await paginateQuery(
        page,
        s.db.select().from(providers).where(where).orderBy(...orderBy).limit(limit).offset(offset),
        countAll(s.db, providers, where),
      );
      return c.json(result);
    })

    .post('/', jsonBody(providerCreateSchema), async (c) => {
      const body = c.req.valid('json');
      const [created] = await s.db
        .insert(providers)
        .values({
          name: body.name,
          protocol: body.protocol ?? 'openai-compatible',
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
      const id = intParam(c, 'id');
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
      if (!updated) throw new HttpError('PROVIDER_NOT_FOUND', '供应商不存在');
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
      const id = intParam(c, 'id');
      const [retired] = await s.db
        .update(providers)
        .set({ status: 1 })
        .where(eq(providers.id, id))
        .returning({ id: providers.id });
      if (!retired) throw new HttpError('PROVIDER_NOT_FOUND', '供应商不存在');
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
