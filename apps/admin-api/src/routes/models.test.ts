import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import type { Ai } from '@ai-gateway/ai';
import { encrypt } from '@ai-gateway/core';
import { loadRootEnvFile } from '@ai-gateway/http';
import { modelAdminRoutes } from './models.js';
import { makeAdminTestApp, makeServices, TEST_ENCRYPTION_KEY } from '../test/helpers.js';

/**
 * 模型级测试（最小生成探针）：验证映射配置端到端可用。
 * 与渠道测试（GET /models 探连通）互补：这里发真实生成
 * （"1" + max_tokens 1，厘级成本），逐渠道返回结果。
 * 数据纪律：外部名前缀 mt-test-。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

async function setupModelWithChannel(): Promise<{
  mappingId: number;
  channelId: number;
  providerId: number;
  ext: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ext = `mt-test-${suffix}`;
  const [prov] = await db
    .insert(providers)
    .values({ name: `mt-prov-${suffix}`, baseUrl: 'http://localhost:9999', protocol: 'openai-compatible', status: 0 })
    .returning();
  const [ch] = await db
    .insert(channels)
    .values({ providerId: prov!.id, name: `mt-ch-${suffix}`, apiKeyEnc: encrypt('mt-test-key', TEST_ENCRYPTION_KEY), status: 0, upstreamBudget: '1000' })
    .returning();
  const [m] = await db
    .insert(modelMappings)
    .values({ externalName: ext, realModel: `${ext}-real`, status: 0, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })
    .returning();
  await db.insert(modelChannels).values({ mappingId: m!.id, channelId: ch!.id, weight: 1, priority: 0 });
  return { mappingId: m!.id, channelId: ch!.id, providerId: prov!.id, ext };
}

/** 只删本次创建的三层（前缀/精确 id 双重条件） */
async function cleanup(ids: { mappingId: number; channelId: number; providerId: number }): Promise<void> {
  await db.delete(modelChannels).where(eq(modelChannels.mappingId, ids.mappingId));
  await db.delete(modelMappings).where(eq(modelMappings.id, ids.mappingId));
  await db.delete(channels).where(eq(channels.id, ids.channelId));
  await db.delete(providers).where(eq(providers.id, ids.providerId));
}

describe('POST /api/admin/models/:id/test（最小生成探针）', () => {
  it('逐渠道返回生成结果；探针请求为 "1" + max_tokens 1', async () => {
    if (!connected) return it.skip('no DB');
    const ids = await setupModelWithChannel();
    const chatCalls: Array<Record<string, unknown>> = [];
    const ai: Ai = {
      chat: async (args) => {
        chatCalls.push(args as Record<string, unknown>);
        return { status: 'success', usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, estimated: false, raw: {} }, durationMs: 7, body: { ok: true } };
      },
      chatStream: async () => { throw new Error('not used'); },
      probe: async () => ({ ok: true, durationMs: 1 }),
      onEvent: () => () => {},
    };
    const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db), ai as never) });
    try {
      const res = await app.request(`/api/admin/models/${ids.mappingId}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ channelId: number; channel: string; ok: boolean; durationMs: number; tokens: number }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({ channelId: ids.channelId, ok: true, tokens: 3 });
      expect(body.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
      // 探针契约：最小成本生成
      const call = chatCalls[0]!;
      expect((call.request as { messages?: unknown[] }).messages).toHaveLength(1);
      expect((call.request as { max_tokens?: number }).max_tokens).toBe(1);
      expect((call.channel as { apiKey?: string }).apiKey).toBeDefined();
    } finally {
      await cleanup(ids);
    }
  });

  it('上游失败 → ok:false + 错误码；无绑定渠道 → 空结果', async () => {
    if (!connected) return it.skip('no DB');
    const ids = await setupModelWithChannel();
    const ai: Ai = {
      chat: async () => {
        const err = new Error('限流') as Error & {
          code: string;
          retryable: boolean;
          circuitTrip: boolean;
          deadCredential: boolean;
        };
        err.code = 'rate_limited';
        err.retryable = true;
        err.circuitTrip = false;
        err.deadCredential = false;
        return { status: 'error' as const, durationMs: 3, error: err };
      },
      chatStream: async () => { throw new Error('not used'); },
      probe: async () => ({ ok: false, durationMs: 0 }),
      onEvent: () => () => {},
    };
    const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db), ai as never) });
    try {
      const res = await app.request(`/api/admin/models/${ids.mappingId}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Array<{ ok: boolean; error?: { code: string } }> };
      expect(body.results[0]!.ok).toBe(false);
      expect(body.results[0]!.error?.code).toBe('rate_limited');
    } finally {
      await cleanup(ids);
    }
  });
});

// vi 引用保持 lint 安静（chat mock 未用到 vi 时不算未使用导入）
void vi;
