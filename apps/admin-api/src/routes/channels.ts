import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { channels, providers } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { decrypt } from '@ai-gateway/core';
import { createAi, defaultAiConfig } from '@ai-gateway/ai';
import { MONEY_MAX, HttpError, jsonBody, maskUpstreamKey, intParam, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import {
  channelImportSchema, createChannel, importChannels, listChannels, retireChannel, updateChannel,
} from '../services/channels.js';
import { MemoryKvStorage, type BreakerState, type DeadCredentialState } from '@ai-gateway/ai';

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
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1, 'apiKey 不能为空').max(512),
  baseUrlOverride: z.string().max(255).nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().int().min(0).max(1_000_000).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  /** 渠道级限流（保护上游 API key 配额；null=不限流） */
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
}).passthrough();

const channelUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  baseUrlOverride: z.string().max(255).nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().int().min(0).max(1_000_000).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  status: z.number().int().min(0).max(4).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  /** 熔断阈值（元，>=0），null=0（耗尽才熔断） */
  upstreamThreshold: z.number().min(0).max(MONEY_MAX).nullable().optional(),
  /** 换 Key：重新加密 + 恢复启用状态 */
  apiKey: z.string().min(1).optional(),
}).passthrough();

export function channelAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // ====== 列表（含绑定模型/上游消耗聚合，见 service）======

    .get('/', query(listQuerySchema), async (c) =>
      c.json(await listChannels(s, c.req.valid('query'))),
    )

    // ====== 创建（Key 加密与审计见 service）======

    .post('/', jsonBody(channelCreateSchema), async (c) => {
      const created = await createChannel(s, c.req.valid('json'), c.get('adminId'));
      // 响应不含 key（明文或密文都不返回）
      return c.json(created, 201);
    })

    // ====== 更新（换 Key 重加密 + 恢复启用见 service）======

    .patch('/:id', jsonBody(channelUpdateSchema), async (c) => {
      const updated = await updateChannel(s, intParam(c, 'id'), c.req.valid('json'), c.get('adminId'));
      return c.json(updated);
    })

    .delete('/:id', async (c) => {
      await retireChannel(s, intParam(c, 'id'), c.get('adminId'));
      return c.json({ ok: true });
    })

    // ====== 连通性测试 ======

    .post('/:id/test', async (c) => {
      const id = intParam(c, 'id');
      const ch = await s.db
        .select({ apiKeyEnc: channels.apiKeyEnc, baseUrlOverride: channels.baseUrlOverride, providerBaseUrl: providers.baseUrl, providerProtocol: providers.protocol })
        .from(channels)
        .innerJoin(providers, eq(channels.providerId, providers.id))
        .where(eq(channels.id, id))
        .limit(1);
      if (ch.length === 0) throw new HttpError('CHANNEL_NOT_FOUND', '渠道不存在');

      const row = ch[0]!;
      const apiKey = decrypt(row.apiKeyEnc, s.encryptionKey, s.encryptionKeyOld);
      const baseUrl = row.baseUrlOverride ?? row.providerBaseUrl;
      const protocol = row.providerProtocol;
      const ai = createAi(
        {
          ...defaultAiConfig(),
          // 与网关同源门控：开发放行内网上游（生产即便误配也被 NODE_ENV 拦下）
          allowLocalUrl: s.allowLocalUpstream,
        },
        // 探测是独立诊断面：每次探测全新内存状态（不受网关熔断影响、不污染它）
        {
          breakerStorage: new MemoryKvStorage<BreakerState>(),
          deadCredentialStorage: new MemoryKvStorage<DeadCredentialState>(),
        },
      );
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
