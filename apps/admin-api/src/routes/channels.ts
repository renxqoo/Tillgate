import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { providers, channels, modelMappings, modelChannels, usageLogs } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { decrypt, encrypt } from '@ai-gateway/core';
import { createAi, defaultAiConfig, type ChannelDesc } from '@ai-gateway/ai';
import { bumpRouteCache, HttpError, jsonBody, maskUpstreamKey, recordAudit } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { channelImportSchema, importChannels } from '../services/channels.js';

/**
 * 渠道管理（api-contract §4.5）。
 *
 * 安全设计：
 *   - 上游 Key 明文只在创建/换 Key 的请求体中出现一次
 *   - DB 存储 AES-256-GCM 密文（api_key_enc）
 *   - 列表/详情响应永不回显明文 Key（只显示脱敏）
 *   - PATCH 换 Key 后自动清除「凭据无效」状态（status 恢复 0 + failCount 重置）
 */

const channelCreateSchema = z.object({
  providerId: z.number().int().positive(),
  name: z.string().min(1),
  apiKey: z.string().min(1, 'apiKey 不能为空'),
  baseUrlOverride: z.string().nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().optional(),
  priority: z.number().optional(),
  /** 渠道级限流（保护上游 API key 配额；null=不限流） */
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
}).passthrough();

const channelUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrlOverride: z.string().nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().optional(),
  priority: z.number().optional(),
  status: z.number().optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  /** 熔断阈值（元，>=0），null=0（耗尽才熔断） */
  upstreamThreshold: z.number().min(0).nullable().optional(),
  /** 换 Key：重新加密 + 恢复启用状态 */
  apiKey: z.string().min(1).optional(),
}).passthrough();

export function channelAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // ====== 列表 ======

    .get('/', async (c) => {
      const rows = await s.db
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
          upstreamBudget: channels.upstreamBudget,
          upstreamThreshold: channels.upstreamThreshold,
          createdAt: channels.createdAt,
          updatedAt: channels.updatedAt,
          providerName: providers.name,
          providerBaseUrl: providers.baseUrl,
        })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .orderBy(channels.id);

      // 查每个渠道绑定的模型映射，join 到返回里
      const bindings = await s.db
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

      // 渠道已消耗（上游成本）聚合：consumed = sum(upstream_cost)，只计成功结算（报表用）
      const consumedRows = await s.db
        .select({
          channelId: usageLogs.channelId,
          total: sql<string>`coalesce(sum(${usageLogs.upstreamCost}),0)::numeric`,
        })
        .from(usageLogs)
        .where(eq(usageLogs.status, 0))
        .groupBy(usageLogs.channelId);
      const consumedMap = new Map<number, string>();
      for (const cr of consumedRows) {
        if (cr.channelId != null) consumedMap.set(cr.channelId, cr.total);
      }

      const list = rows.map((r) => {
        const consumed = consumedMap.get(r.id) ?? '0';
        return {
          ...r,
          boundModels: bindingMap.get(r.id) ?? [],
          // upstreamBudget 即「当前余额」（结算已扣减），已消耗单独给出供报表/追溯
          upstreamConsumed: consumed,
          upstreamRemaining: r.upstreamBudget,
        };
      });
      return c.json({ list, total: list.length });
    })

    // ====== 创建 ======

    .post('/', jsonBody(channelCreateSchema), async (c) => {
      const body = c.req.valid('json');
      // 明文 key → AES 加密 → 存 DB（明文不保留在任何返回值/日志中）
      const apiKeyEnc = encrypt(body.apiKey, s.encryptionKey);
      const [created] = await s.db
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
      s.logger.info({ channelId: created!.id, name: created!.name }, 'channel created (key encrypted)');
      await bumpRouteCache(s.redis);
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'channel.create',
        targetType: 'channel',
        targetId: created!.id,
        detail: { name: created!.name, providerId: created!.providerId },
      });
      // 响应不含 key（明文或密文都不返回）
      return c.json(created, 201);
    })

    // ====== 更新 ======

    .patch('/:id', jsonBody(channelUpdateSchema), async (c) => {
      const id = Number(c.req.param('id'));
      const body = c.req.valid('json');
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
      if (body.upstreamThreshold !== undefined)
        update.upstreamThreshold = body.upstreamThreshold == null ? null : String(body.upstreamThreshold);
      // 换 Key：重新加密 + 清除「凭据无效」状态（status=4 死凭据/3 熔断 → 恢复启用）
      if (body.apiKey !== undefined) {
        update.apiKeyEnc = encrypt(body.apiKey, s.encryptionKey);
        update.status = 0;
        update.failCount = 0;
        update.cooldownUntil = null;
      }
      const [updated] = await s.db.update(channels).set(update).where(eq(channels.id, id)).returning({
        id: channels.id,
        name: channels.name,
        status: channels.status,
        failCount: channels.failCount,
      });
      if (!updated) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
      await bumpRouteCache(s.redis);
      s.logger.info({ channelId: id, keyChanged: body.apiKey !== undefined }, 'channel updated');
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'channel.update',
        targetType: 'channel',
        targetId: id,
        detail: { keyChanged: body.apiKey !== undefined, ...(body.name !== undefined ? { name: body.name } : {}) },
      });
      return c.json(updated);
    })

    .delete('/:id', async (c) => {
      const id = Number(c.req.param('id'));
      const [retired] = await s.db
        .update(channels)
        .set({ status: 1, updatedAt: new Date() })
        .where(eq(channels.id, id))
        .returning({ id: channels.id });
      if (!retired) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '渠道不存在');
      await bumpRouteCache(s.redis);
      await recordAudit(s.db, {
        actor: 'admin',
        adminId: c.get('adminId'),
        action: 'channel.retire',
        targetType: 'channel',
        targetId: id,
      });
      return c.json({ ok: true });
    })

    // ====== 连通性测试 ======

    .post('/:id/test', async (c) => {
      const id = Number(c.req.param('id'));
      const ch = await s.db
        .select({ apiKeyEnc: channels.apiKeyEnc, baseUrlOverride: channels.baseUrlOverride, providerBaseUrl: providers.baseUrl, providerProtocol: providers.protocol })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(eq(channels.id, id))
        .limit(1);
      if (ch.length === 0) throw new HttpError(404, 'CHANNEL_NOT_FOUND', '渠道不存在');

      const row = ch[0]!;
      const apiKey = decrypt(row.apiKeyEnc, s.encryptionKey);
      const baseUrl = row.baseUrlOverride ?? row.providerBaseUrl;
      const protocol = row.providerProtocol.replace('_', '-') as ChannelDesc['protocol'];
      const ai = createAi({
        ...defaultAiConfig(),
        // 与网关同源门控：开发放行内网上游（生产即便误配也被 NODE_ENV 拦下）
        allowLocalUrl: s.allowLocalUpstream,
      });
      const result = await ai.probe({ baseUrl, apiKey, protocol });
      return c.json({
        ok: result.ok,
        durationMs: result.durationMs,
        error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
        keyPreview: maskUpstreamKey(apiKey),
      });
    })

    // ====== 批量导入 ======

    .post('/import', jsonBody(channelImportSchema), async (c) => {
      const result = await importChannels(s, c.req.valid('json').channels, c.get('adminId'));
      return c.json(result, result.success > 0 ? 200 : 400);
    });
}
