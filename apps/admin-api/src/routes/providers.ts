import { Hono } from 'hono';
import { z } from 'zod';
import { intParam, jsonBody, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import { SUPPORTED_PROTOCOLS } from '@ai-gateway/ai';
import type { AdminServices } from '../services/index.js';
import { createProvider, listProviders, retireProvider, updateProvider } from '../services/providers.js';

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

    .get('/', query(listQuerySchema), async (c) =>
      c.json(await listProviders(s, c.req.valid('query'))),
    )

    .post('/', jsonBody(providerCreateSchema), async (c) => {
      const created = await createProvider(s, c.req.valid('json'), c.get('adminId'));
      return c.json(created, 201);
    })

    .patch('/:id', jsonBody(providerUpdateSchema), async (c) => {
      const updated = await updateProvider(s, intParam(c, 'id'), c.req.valid('json'), c.get('adminId'));
      return c.json(updated);
    })

    .delete('/:id', async (c) => {
      await retireProvider(s, intParam(c, 'id'), c.get('adminId'));
      return c.json({ ok: true });
    });
}
