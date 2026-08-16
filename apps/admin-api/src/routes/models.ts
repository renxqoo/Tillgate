import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { channels, modelMappings, modelChannels, providers } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { createAi, defaultAiConfig, type Ai, type ChannelDesc } from '@ai-gateway/ai';
import { decrypt } from '@ai-gateway/core';
import { MONEY_MAX, intParam, HttpError, jsonBody, query, listQuerySchema } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { createModel, listModels, replaceModelChannels, retireModel, updateModel } from '../services/models.js';
import { MemoryKvStorage, type BreakerState, type DeadCredentialState } from '@ai-gateway/ai';

const billingPolicySchema = z.object({
  version: z.literal(1),
  billingMode: z.literal('unified_input_tokens'),
  maxInputTokens: z.number().int().positive(),
  modalities: z
    .object({
      image: z
        .object({
          maxItems: z.number().int().positive(),
          maxInlineBytes: z.number().int().positive().optional(),
        })
        .optional(),
      audio: z
        .object({
          maxItems: z.number().int().positive(),
          maxInlineBytes: z.number().int().positive().optional(),
        })
        .optional(),
      file: z
        .object({
          maxItems: z.number().int().positive(),
          maxInlineBytes: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .strict(),
});

/**
 * 模型映射与渠道绑定（api-contract §4.5）。
 *
 *   - GET  /：模型列表（附已绑定渠道 channelIds，供前端弹窗回显）
 *   - POST / | PATCH /:id | DELETE /:id：映射 CRUD（价格存 numeric 字符串列）
 *   - POST /:id/channels：绑定渠道（全量替换语义，事务保证，见 services/models）
 */

const modelCreateSchema = z
  .object({
    externalName: z.string().min(1).max(64),
    realModel: z.string().min(1).max(128),
    inputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX).optional(),
    outputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX).optional(),
    cacheInputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX).optional(),
    /** 显式免费模型（0 元授权）；付费模型必须 false。 */
    isFree: z.boolean().optional(),
    /** 上下文窗口（token 数）；null=未知 */
    contextLength: z.coerce.number().int().positive().finite().max(2_000_000_000).nullable().optional(),
    /** 模型级限流（保护上游配额）；null=不限流 */
    rpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
    tpmLimit: z.number().int().positive().max(1_000_000_000).nullable().optional(),
    billingPolicy: billingPolicySchema.nullable().optional(),
  })
  .passthrough();

const modelUpdateSchema = z
  .object({
    externalName: z.string().min(1).max(64).optional(),
    realModel: z.string().min(1).max(128).optional(),
    status: z.number().int().min(0).max(1).optional(),
    inputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX).optional(),
    outputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX).optional(),
    cacheInputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX).optional(),
    isFree: z.boolean().optional(),
    contextLength: z.coerce.number().int().positive().finite().max(2_000_000_000).nullable().optional(),
    fallbackModels: z.unknown().optional(),
    paramRules: z.unknown().optional(),
    billingPolicy: billingPolicySchema.nullable().optional(),
    rpmLimit: z.number().int().positive().nullable().optional(),
    tpmLimit: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

const bindChannelsSchema = z.object({
  /** 全量替换的渠道绑定列表（可为空数组=解绑全部） */
  channels: z.array(
    z.object({
      channelId: z.number().int().positive(),
      weight: z.number().optional(),
      priority: z.number().optional(),
    }),
  ),
});

export function modelAdminRoutes(s: AdminServices, ai?: Ai): Hono<AdminEnv> {
  return (
    new Hono<AdminEnv>()

      // 模型列表 + 已绑定渠道 id 回显
      .get('/', query(listQuerySchema), async (c) =>
        c.json(await listModels(s, c.req.valid('query'))),
      )

      .post('/', jsonBody(modelCreateSchema), async (c) => {
        const created = await createModel(s, c.req.valid('json'), c.get('adminId'));
        return c.json(created, 201);
      })

      .patch('/:id', jsonBody(modelUpdateSchema), async (c) => {
        const updated = await updateModel(s, intParam(c, 'id'), c.req.valid('json'), c.get('adminId'));
        return c.json(updated);
      })

      .delete('/:id', async (c) => {
        await retireModel(s, intParam(c, 'id'), c.get('adminId'));
        return c.json({ ok: true });
      })

      // 绑定渠道（全量替换，事务保证原子性）
      .post('/:id/channels', jsonBody(bindChannelsSchema), async (c) => {
        const mappingId = intParam(c, 'id');
        const body = c.req.valid('json');
        const bound = await replaceModelChannels(s, mappingId, body.channels, c.get('adminId'));
        return c.json({ ok: true, bound });
      })

      /**
       * 模型级测试（最小生成探针）：逐绑定渠道发真实生成（"1" + max_tokens 1，
       * 厘级成本），验证 映射配置+协议适配+鉴权+生成 全链路。
       * 与渠道测试互补（后者只探连通与 key）。
       */
      .post('/:id/test', async (c) => {
        const mappingId = intParam(c, 'id');
        const mapping = await s.db.query.modelMappings.findFirst({
          where: eq(modelMappings.id, mappingId),
        });
        if (!mapping) throw new HttpError('MODEL_NOT_FOUND', '模型不存在');
        const bound = await s.db
          .select({
            channelId: channels.id,
            channelName: channels.name,
            apiKeyEnc: channels.apiKeyEnc,
            baseUrlOverride: channels.baseUrlOverride,
            providerBaseUrl: providers.baseUrl,
            providerProtocol: providers.protocol,
          })
          .from(modelChannels)
          .innerJoin(channels, eq(channels.id, modelChannels.channelId))
          .innerJoin(providers, eq(providers.id, channels.providerId))
          .where(eq(modelChannels.mappingId, mappingId));
        // 与渠道测试同一 Ai 实例语义：开发放行内网上游（双重门控在 services 注入时完成）
        const tester =
          ai ??
          createAi(
            {
              ...defaultAiConfig(),
              allowLocalUrl: s.allowLocalUpstream,
            },
            // 探测是独立诊断面：每次探测全新内存状态（不受网关熔断影响、不污染它）
            {
              breakerStorage: new MemoryKvStorage<BreakerState>(),
              deadCredentialStorage: new MemoryKvStorage<DeadCredentialState>(),
            },
          );
        const results = [];
        for (const ch of bound) {
          const desc: ChannelDesc = {
            baseUrl: ch.baseUrlOverride ?? ch.providerBaseUrl,
            apiKey: decrypt(ch.apiKeyEnc, s.encryptionKey, s.encryptionKeyOld),
            protocol: ch.providerProtocol,
          };
          const startedAt = Date.now();
          try {
            const result = await tester.chat({
              channel: desc,
              request: {
                model: mapping.realModel,
                messages: [{ role: 'user', content: '1' }],
                max_tokens: 1,
              },
              ctx: {
                requestId: `model-test-${mapping.id}-${ch.channelId}`,
                model: mapping.realModel,
                providerName: ch.providerProtocol,
                maxRetries: 0,
              },
            });
            if (result.status === 'success') {
              results.push({
                channelId: ch.channelId,
                channel: ch.channelName,
                ok: true,
                durationMs: Date.now() - startedAt,
                tokens:
                  (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
              });
            } else {
              results.push({
                channelId: ch.channelId,
                channel: ch.channelName,
                ok: false,
                durationMs: Date.now() - startedAt,
                error: result.error
                  ? { code: result.error.code, message: result.error.message }
                  : { code: 'unknown', message: '无错误信息' },
              });
            }
          } catch (error) {
            results.push({
              channelId: ch.channelId,
              channel: ch.channelName,
              ok: false,
              durationMs: Date.now() - startedAt,
              error: { code: 'internal', message: (error as Error).message },
            });
          }
        }
        return c.json({ results });
      })
  );
}
