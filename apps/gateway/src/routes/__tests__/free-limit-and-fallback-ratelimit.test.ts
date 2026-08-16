import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import { loadGatewayEnv } from '@ai-gateway/core';
import type { UpstreamError } from '@ai-gateway/ai';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  encrypt,
} from '../../testing/helpers.js';

/**
 * A1（R6）：免费模型每日限额——FREE_MODEL_DAILY_LIMIT=N 时第 N+1 次 429（业务码 +
 * retry-after），非免费模型不受影响。
 * A2（R6/G3）：fallback 模型限流维——fallback 模型维 RPM 超限时跳过该候选
 * （不无计量承接），全候选耗尽 → 503 rate_limited。
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

function networkError(): UpstreamError {
  const err = new Error('connect ECONNREFUSED') as UpstreamError;
  err.code = 'network';
  err.retryable = true;
  err.circuitTrip = true;
  err.deadCredential = false;
  return err;
}

interface Fixture {
  providerId: number;
  mappingIds: number[];
  channelIds: number[];
}

async function createMapping(opts: {
  external: string;
  real: string;
  prices: [string, string, string];
  isFree?: boolean;
  rpmLimit?: number | null;
  fallbackModels?: string[];
  providerId: number;
  encKey: string;
}): Promise<{ mappingId: number; channelId: number }> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [ch] = await db
    .insert(channels)
    .values({
      name: `fl-ch-${suffix}`,
      providerId: opts.providerId,
      apiKeyEnc: encrypt('sk-fl', opts.encKey),
      status: 0,
      upstreamBudget: '1000000',
    })
    .returning();
  const [m] = await db
    .insert(modelMappings)
    .values({
      externalName: opts.external,
      realModel: opts.real,
      status: 0,
      inputPrice: opts.prices[0],
      outputPrice: opts.prices[1],
      cacheInputPrice: opts.prices[2],
      isFree: opts.isFree ?? false,
      rpmLimit: opts.rpmLimit ?? null,
      fallbackModels: opts.fallbackModels ?? null,
    })
    .returning();
  await db.insert(modelChannels).values({ mappingId: m!.id, channelId: ch!.id, priority: 0, weight: 1 });
  return { mappingId: m!.id, channelId: ch!.id };
}

async function makeProvider(): Promise<number> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [prov] = await db
    .insert(providers)
    .values({ name: `fl-prov-${suffix}`, protocol: 'openai-compatible', baseUrl: 'http://localhost:9999', status: 0 })
    .returning();
  return prov!.id;
}

function successAi(realModel: string, failReal?: string) {
  return makeMockAi({
    chat: vi.fn(async (input: { ctx: { model: string } }) => {
      if (failReal && input.ctx.model === failReal) {
        return { status: 'error' as const, error: networkError(), durationMs: 5 };
      }
      void realModel;
      return {
        status: 'success' as const,
        usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, estimated: false, raw: {} },
        body: { id: 'mock', object: 'chat.completion', choices: [] },
        durationMs: 5,
      };
    }),
  });
}

describe('A1 免费模型每日限额', () => {
  it('FREE_MODEL_DAILY_LIMIT=2：前 2 次 200，第 3 次 429 free_model_daily_limit_exceeded + retry-after', async (context) => {
    if (!connected) return context.skip('no DB');
    const userId = await createTestUser(db, '1000', 'freelim');
    const { token, keyHash } = await createTestApiKey(db, userId, 'freelim');
    const providerId = await makeProvider();
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const { mappingId, channelId } = await createMapping({
      external: `free-${suffix}`,
      real: `free-${suffix}-real`,
      prices: ['0', '0', '0'],
      isFree: true,
      providerId,
      encKey: process.env.ENCRYPTION_KEY!,
    });
    const env = { ...loadGatewayEnv(), FREE_MODEL_DAILY_LIMIT: 2 };
    const app = buildTestApp(db, redis, successAi(''), env);
    const freeKey = `free:req:{${userId}}:${new Date().toISOString().slice(0, 10)}`;
    try {
      const call = () =>
        app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: `free-${suffix}`, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
        });
      const r1 = await call();
      expect(r1.status).toBe(200);
      const r2 = await call();
      expect(r2.status).toBe(200);
      const r3 = await call();
      expect(r3.status).toBe(429);
      const body = (await r3.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('free_model_daily_limit_exceeded');
      expect(Number(r3.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, { providerId });
      await db.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId)).catch(() => {});
      await db.delete(modelMappings).where(eq(modelMappings.id, mappingId)).catch(() => {});
      await db.delete(channels).where(eq(channels.id, channelId)).catch(() => {});
      await redis.del(freeKey).catch(() => {});
    }
  });
});

describe('A2 fallback 模型限流维', () => {
  it('fallback 模型维 RPM=1：首次降级承接成功，第二次跳过该候选 → 503 rate_limited', async (context) => {
    if (!connected) return context.skip('no DB');
    const userId = await createTestUser(db, '1000', 'fbrpm');
    const { token, keyHash } = await createTestApiKey(db, userId, 'fbrpm');
    const providerId = await makeProvider();
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const main = await createMapping({
      external: `fbm-${suffix}`,
      real: `fbm-${suffix}-real`,
      prices: ['1000', '2000', '100'],
      fallbackModels: [`fbf-${suffix}`],
      providerId,
      encKey: process.env.ENCRYPTION_KEY!,
    });
    const fb = await createMapping({
      external: `fbf-${suffix}`,
      real: `fbf-${suffix}-real`,
      prices: ['1000', '2000', '100'],
      rpmLimit: 1, // fallback 模型维 RPM = 1
      providerId,
      encKey: process.env.ENCRYPTION_KEY!,
    });
    const ai = successAi('', `fbm-${suffix}-real`); // 主模型渠道恒失败（可换渠道）
    const app = buildTestApp(db, redis, ai);
    const call = () =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `fbm-${suffix}`, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      });
    const fixture: Fixture = { providerId, mappingIds: [main.mappingId, fb.mappingId], channelIds: [main.channelId, fb.channelId] };
    try {
      const r1 = await call();
      expect(r1.status).toBe(200); // 主失败 → fallback 维 RPM 计数 1 → 承接成功
      expect(ai.chat).toHaveBeenCalledTimes(2);

      const r2 = await call();
      expect(r2.status).toBe(503); // fallback 维计数 2 > 1 → 跳过 → 全候选耗尽
      const body = (await r2.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('no_available_channel');
      // 第二次只派发了主渠道（fallback 未被无计量承接）
      expect(ai.chat).toHaveBeenCalledTimes(3);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, { providerId });
      for (const mid of fixture.mappingIds) await db.delete(modelChannels).where(eq(modelChannels.mappingId, mid)).catch(() => {});
      for (const mid of fixture.mappingIds) await db.delete(modelMappings).where(eq(modelMappings.id, mid)).catch(() => {});
      for (const cid of fixture.channelIds) await db.delete(channels).where(eq(channels.id, cid)).catch(() => {});
      await redis.del(`rl:{rpm}:model:${fb.mappingId}`).catch(() => {});
    }
  });
});
