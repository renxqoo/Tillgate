import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  providers,
  channels,
  modelMappings,
  modelChannels,
} from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { createAi, defaultAiConfig, type ChannelDesc } from '@ai-gateway/ai';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { invalidateRouteCache } from '../lib/route-invalidation.js';
import { jsonBody } from '../lib/validation.js';
import { z } from 'zod';
import { env, logger } from '../index.js';

/** 管理端 schema 定义 */
const providerCreateSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  protocol: z.string().optional(),
  status: z.number().optional(),
}).passthrough();

const channelCreateSchema = z.object({
  providerId: z.number().int().positive(),
  name: z.string().min(1),
  apiKey: z.string().min(1, 'apiKey 不能为空'),
  baseUrlOverride: z.string().nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().optional(),
  priority: z.number().optional(),
  /** 渠道级限流（保护上游 API key 配额；null=不限流）。G-RL 限流重构新增可配置项 */
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
}).passthrough();

const modelCreateSchema = z.object({
  externalName: z.string().min(1),
  realModel: z.string().min(1),
  inputPrice: z.coerce.number().optional(),
  outputPrice: z.coerce.number().optional(),
  cacheInputPrice: z.coerce.number().optional(),
  /** 模型级限流（保护上游配额）；null=不限流 */
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
}).passthrough();

/**
 * 渠道管理（api-contract §4.5）
 *
 * 安全设计：
 *   - 上游 Key 明文只在创建/换 Key 的请求体中出现一次
 *   - DB 存储 AES-256-GCM 密文（api_key_enc）
 *   - 列表/详情响应永不回显明文 Key（只显示脱敏 ****abcd）
 *   - PATCH 换 Key 后自动清除「凭据无效」状态
 */
export function channelAdminRoutes(db: Db): Hono {
  return new Hono()

    // ====== Providers ======

    .get('/api/admin/providers', async (c) => {
      const rows = await db.select().from(providers).orderBy(providers.id);
      return c.json({ list: rows, total: rows.length });
    })

    .post('/api/admin/providers', jsonBody(providerCreateSchema), async (c) => {
      const body = c.req.valid('json');
      if (!body.name || !body.baseUrl) return c.json({ error: '缺少 name 或 baseUrl' }, 400);
      const [created] = await db
        .insert(providers)
        .values({
          name: body.name,
          protocol: body.protocol ?? 'openai_compatible',
          baseUrl: body.baseUrl,
          status: body.status ?? 0,
        })
        .returning();
      invalidateRouteCache();
      return c.json(created, 201);
    })

    .patch('/api/admin/providers/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const body = await c.req.json();
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) update.name = body.name;
      if (body.baseUrl !== undefined) update.baseUrl = body.baseUrl;
      if (body.protocol !== undefined) update.protocol = body.protocol;
      if (body.status !== undefined) update.status = body.status;
      const [updated] = await db
        .update(providers)
        .set(update)
        .where(eq(providers.id, id))
        .returning();
      if (!updated) return c.json({ error: '供应商不存在' }, 404);
      invalidateRouteCache();
      return c.json(updated);
    })

    .delete('/api/admin/providers/:id', async (c) => {
      const id = Number(c.req.param('id'));
      await db.delete(providers).where(eq(providers.id, id));
      invalidateRouteCache();
      return c.json({ ok: true });
    })

    // ====== Channels ======

    .get('/api/admin/channels', async (c) => {
      const rows = await db
        .select({
          id: channels.id,
          providerId: channels.providerId,
          name: channels.name,
          baseUrlOverride: channels.baseUrlOverride,
          models: channels.models,
          weight: channels.weight,
          priority: channels.priority,
          status: channels.status,
          failCount: channels.failCount,
          cooldownUntil: channels.cooldownUntil,
          rpmLimit: channels.rpmLimit,
          tpmLimit: channels.tpmLimit,
          createdAt: channels.createdAt,
          updatedAt: channels.updatedAt,
          providerName: providers.name,
          providerBaseUrl: providers.baseUrl,
        })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .orderBy(channels.id);

      // 查每个渠道绑定的模型映射，join 到返回里
      const bindings = await db
        .select({
          channelId: modelChannels.channelId,
          externalName: modelMappings.externalName,
          realModel: modelMappings.realModel,
        })
        .from(modelChannels)
        .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id));

      const bindingMap = new Map<number, Array<{ externalName: string; realModel: string }>>();
      for (const b of bindings) {
        const arr = bindingMap.get(b.channelId) ?? [];
        arr.push({ externalName: b.externalName, realModel: b.realModel });
        bindingMap.set(b.channelId, arr);
      }

      const rowsWithModels = rows.map((r) => ({
        ...r,
        boundModels: bindingMap.get(r.id) ?? [],
      }));

      return c.json({ list: rowsWithModels, total: rowsWithModels.length });
    })

    .post('/api/admin/channels', jsonBody(channelCreateSchema), async (c) => {
      const body = c.req.valid('json');
      if (!body.providerId || !body.name || !body.apiKey) {
        return c.json({ error: '缺少 providerId、name 或 apiKey' }, 400);
      }
      // 明文 key → AES 加密 → 存 DB（明文不保留在任何返回值/日志中）
      const apiKeyEnc = encrypt(body.apiKey, env.ENCRYPTION_KEY);
      const [created] = await db
        .insert(channels)
        .values({
          providerId: body.providerId,
          name: body.name,
          apiKeyEnc,
          baseUrlOverride: body.baseUrlOverride ?? null,
          models: body.models ?? null,
          weight: body.weight ?? 1,
          priority: body.priority ?? 0,
          rpmLimit: body.rpmLimit ?? null,
          tpmLimit: body.tpmLimit ?? null,
          status: 0,
        })
        .returning({ id: channels.id, name: channels.name, providerId: channels.providerId });
      logger.info({ channelId: created!.id, name: created!.name }, 'channel created (key encrypted)');
      invalidateRouteCache();
      // 响应不含 key（明文或密文都不返回）
      return c.json(created, 201);
    })

    .patch('/api/admin/channels/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const body = await c.req.json();
      const update: Record<string, unknown> = { updatedAt: new Date() };
      // 可更新字段（白名单）
      if (body.name !== undefined) update.name = body.name;
      if (body.baseUrlOverride !== undefined) update.baseUrlOverride = body.baseUrlOverride;
      if (body.models !== undefined) update.models = body.models;
      if (body.weight !== undefined) update.weight = body.weight;
      if (body.priority !== undefined) update.priority = body.priority;
      if (body.status !== undefined) update.status = body.status;
      if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
      if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
      // 换 Key：重新加密 + 清除「凭据无效」状态（status 恢复 0 + failCount 重置）
      // status=4 是死凭据自动标记（gateway 检测 401/403 后写回 DB），换 Key 后应恢复路由
      if (body.apiKey !== undefined) {
        update.apiKeyEnc = encrypt(body.apiKey, env.ENCRYPTION_KEY);
        update.status = 0; // 死凭据(4)/熔断(3) 换 Key 后恢复启用
        update.failCount = 0;
        update.cooldownUntil = null;
      }
      const [updated] = await db.update(channels).set(update).where(eq(channels.id, id)).returning({
        id: channels.id,
        name: channels.name,
        status: channels.status,
        failCount: channels.failCount,
      });
      if (!updated) return c.json({ error: '渠道不存在' }, 404);
      invalidateRouteCache();
      logger.info({ channelId: id, keyChanged: body.apiKey !== undefined }, 'channel updated');
      return c.json(updated);
    })

    .delete('/api/admin/channels/:id', async (c) => {
      const id = Number(c.req.param('id'));
      await db.delete(modelChannels).where(eq(modelChannels.channelId, id));
      await db.delete(channels).where(eq(channels.id, id));
      invalidateRouteCache();
      return c.json({ ok: true });
    })

    // ====== 连通性测试 ======

    .post('/api/admin/channels/:id/test', async (c) => {
      const id = Number(c.req.param('id'));
      const ch = await db
        .select({ apiKeyEnc: channels.apiKeyEnc, baseUrlOverride: channels.baseUrlOverride, providerBaseUrl: providers.baseUrl, providerProtocol: providers.protocol })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(eq(channels.id, id))
        .limit(1);
      if (ch.length === 0) return c.json({ error: '渠道不存在' }, 404);

      const row = ch[0]!;
      const apiKey = decrypt(row.apiKeyEnc, env.ENCRYPTION_KEY);
      const baseUrl = row.baseUrlOverride ?? row.providerBaseUrl;
      const protocol = row.providerProtocol.replace('_', '-') as ChannelDesc['protocol'];
      const ai = createAi(defaultAiConfig());
      const result = await ai.probe({ baseUrl, apiKey, protocol });
      return c.json({
        ok: result.ok,
        durationMs: result.durationMs,
        error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
        keyPreview: maskKey(apiKey),
      });
    })

    // ====== 模型映射 + 渠道绑定 ======

    .get('/api/admin/models', async (c) => {
      const rows = await db.select().from(modelMappings).orderBy(modelMappings.id);
      // 附带每个模型已绑定的渠道 id（供前端「绑定渠道」弹窗回显已选）
      const bindings = await db.select().from(modelChannels);
      const channelIdsByModel = new Map<number, number[]>();
      for (const b of bindings) {
        const arr = channelIdsByModel.get(b.mappingId) ?? [];
        arr.push(b.channelId);
        channelIdsByModel.set(b.mappingId, arr);
      }
      const list = rows.map((r) => ({ ...r, channelIds: channelIdsByModel.get(r.id) ?? [] }));
      return c.json({ list, total: list.length });
    })

    .post('/api/admin/models', jsonBody(modelCreateSchema), async (c) => {
      const body = c.req.valid('json');
      if (!body.externalName || !body.realModel) return c.json({ error: '缺少 externalName 或 realModel' }, 400);
      const [created] = await db
        .insert(modelMappings)
        .values({
          externalName: body.externalName,
          realModel: body.realModel,
          status: 0,
          inputPrice: String(body.inputPrice ?? 0),
          outputPrice: String(body.outputPrice ?? 0),
          cacheInputPrice: String(body.cacheInputPrice ?? 0),
          rpmLimit: body.rpmLimit ?? null,
          tpmLimit: body.tpmLimit ?? null,
        })
        .returning();
      invalidateRouteCache();
      return c.json(created, 201);
    })

    .patch('/api/admin/models/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const body = await c.req.json();
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.externalName !== undefined) update.externalName = body.externalName;
      if (body.realModel !== undefined) update.realModel = body.realModel;
      if (body.status !== undefined) update.status = body.status;
      if (body.inputPrice !== undefined) update.inputPrice = String(body.inputPrice);
      if (body.outputPrice !== undefined) update.outputPrice = String(body.outputPrice);
      if (body.cacheInputPrice !== undefined) update.cacheInputPrice = String(body.cacheInputPrice);
      if (body.fallbackModels !== undefined) update.fallbackModels = body.fallbackModels;
      if (body.paramRules !== undefined) update.paramRules = body.paramRules;
      if (body.rpmLimit !== undefined) update.rpmLimit = body.rpmLimit;
      if (body.tpmLimit !== undefined) update.tpmLimit = body.tpmLimit;
      const [updated] = await db
        .update(modelMappings)
        .set(update)
        .where(eq(modelMappings.id, id))
        .returning();
      if (!updated) return c.json({ error: '模型不存在' }, 404);
      invalidateRouteCache();
      return c.json(updated);
    })

    .delete('/api/admin/models/:id', async (c) => {
      const id = Number(c.req.param('id'));
      await db.delete(modelChannels).where(eq(modelChannels.mappingId, id));
      await db.delete(modelMappings).where(eq(modelMappings.id, id));
      invalidateRouteCache();
      return c.json({ ok: true });
    })

    // 绑定渠道到模型
    .post('/api/admin/models/:id/channels', async (c) => {
      const mappingId = Number(c.req.param('id'));
      const body = await c.req.json();
      const binds: Array<{ mappingId: number; channelId: number; weight: number; priority: number }> = [];
      // 兼容前端两种入参：{channels:[{channelId,weight,priority}]}（完整）或 {channelIds:[number]}（简格式）。
      // 原实现只读 body.channels，前端发 {channelIds} 时解析为空 → 删旧插空 → 绑定静默丢失（503 根因）。
      const channelItems: Array<{ channelId: number; weight?: number; priority?: number }> =
        Array.isArray(body.channels) && body.channels.length > 0
          ? body.channels
          : Array.isArray(body.channelIds)
            ? body.channelIds.map((id: number) => ({ channelId: id }))
            : [];
      for (const item of channelItems) {
        binds.push({
          mappingId,
          channelId: item.channelId,
          weight: item.weight ?? 1,
          priority: item.priority ?? 0,
        });
      }
      // 先删旧绑定，再插新的（全量替换）
      await db.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId));
      if (binds.length > 0) {
        await db.insert(modelChannels).values(binds);
      }
      invalidateRouteCache();
      return c.json({ ok: true, bound: binds.length });
    });
}
