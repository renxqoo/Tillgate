import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Ai } from '@ai-gateway/ai';

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFileIntoProcess(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFileIntoProcess();
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-7f3a9b2e5c1d4a8f6e0b';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'test-enc-9a4f2c7d8b1e5a3f6c0d4b2e8a7f1c9d';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const { Redis } = await import('ioredis');
const { eq } = await import('drizzle-orm');
const { createDb } = await import('@ai-gateway/db');
const dbSchema = await import('@ai-gateway/db/schema');
const users = dbSchema.users;
const apiKeys = dbSchema.apiKeys;
const modelMappings = dbSchema.modelMappings;
const channels = dbSchema.channels;
const modelChannels = dbSchema.modelChannels;
const providers = dbSchema.providers;
const { BillingService } = await import('../lib/billing.js');
const { RateLimiter } = await import('../lib/rate-limit.js');
const { MeterProducer } = await import('../lib/meter.js');
const { createApp } = await import('../index.js');
const { encrypt } = await import('../lib/crypto.js');

/**
 * BUG 复现（可用性 + 行为不一致）：embeddings 路由的「可换渠道」错误码集合
 * 与 chat-completions 不一致，漏掉 `dead_credential`（及 forbidden / quota_exhausted /
 * empty_completion / invalid_response）。
 *
 * embeddings.ts:126 内联硬编码：
 *   ['upstream_error','network','timeout','rate_limited','invalid_api_key','circuit_open']
 * chat-completions.ts:412-424 CHANNEL_SWITCHABLE_CODES 多了：
 *   dead_credential / forbidden / quota_exhausted / empty_completion / invalid_response
 *
 * 后果：embeddings 第一个渠道返回 dead_credential（ai 包死凭据检测触发）时，
 * 不像 chat 那样换下一个渠道，而是直接把错误返回给客户端 → 单个坏 key 导致整个 embeddings 不可用。
 * 两条路由对死凭据的处理自相矛盾（注释都说「规则同 chat」）。
 *
 * 本测试：模型绑两个渠道，mock ai.chat 第 1 次返回 dead_credential、第 2 次成功，
 * 断言应换渠道并返回 200（修复前红：返回非 200；修复后绿：200）。
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const db = createDb(DATABASE_URL);
const redis = new Redis(REDIS_URL, { retryStrategy: () => null, lazyConnect: true, maxRetriesPerRequest: null });

let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

async function createUser(balance: string): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test', subject: 'emb-deadbug-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    identityProvider: 'local', displayName: 'EmbDeadBug', balance,
  }).returning();
  return u!.id;
}
async function createApiKey(userId: number): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({ keyHash, keyPreview: 'ag_****' + token.slice(-4), userId, name: 'emb-deadbug', status: 0 });
  return { token, keyHash };
}
/** 模型绑两个渠道（候选循环才有「换渠道」可言） */
async function setupModelWithTwoChannels(): Promise<{ externalModel: string; channelId1: number; channelId2: number; providerId: number; mappingId: number }> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'emb-dead-model-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db.insert(providers).values({ name: 'emb-dead-prov-' + suffix, protocol: 'openai_compatible', baseUrl: 'http://localhost:9999', status: 0 }).returning();
  const [ch1] = await db.insert(channels).values({ name: 'emb-dead-ch1-' + suffix, providerId: prov!.id, apiKeyEnc: encrypt('sk-dead', process.env.ENCRYPTION_KEY!), status: 0 }).returning();
  const [ch2] = await db.insert(channels).values({ name: 'emb-dead-ch2-' + suffix, providerId: prov!.id, apiKeyEnc: encrypt('sk-good', process.env.ENCRYPTION_KEY!), status: 0 }).returning();
  const [m] = await db.insert(modelMappings).values({ externalName: externalModel, realModel, status: 0, inputPrice: '1000', outputPrice: '0', cacheInputPrice: '100' }).returning();
  // 两个渠道都绑定，priority 一致 → 候选列表含两个
  await db.insert(modelChannels).values([
    { mappingId: m!.id, channelId: ch1!.id, priority: 0, weight: 1 },
    { mappingId: m!.id, channelId: ch2!.id, priority: 0, weight: 1 },
  ]);
  return { externalModel, channelId1: ch1!.id, channelId2: ch2!.id, providerId: prov!.id, mappingId: m!.id };
}
async function cleanup(userId: number, keyHash: string, ids: { channelId1: number; channelId2: number; providerId: number; mappingId: number }) {
  const usageLogs = dbSchema.usageLogs;
  const transactions = dbSchema.transactions;
  const requestLogs = dbSchema.requestLogs;
  await db.delete(requestLogs).where(eq(requestLogs.userId, userId)).catch(() => {});
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).catch(() => {});
  await db.delete(transactions).where(eq(transactions.userId, userId)).catch(() => {});
  await db.delete(modelChannels).where(eq(modelChannels.mappingId, ids.mappingId)).catch(() => {});
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash)).catch(() => {});
  await db.delete(modelMappings).where(eq(modelMappings.id, ids.mappingId)).catch(() => {});
  await db.delete(channels).where(eq(channels.id, ids.channelId1)).catch(() => {});
  await db.delete(channels).where(eq(channels.id, ids.channelId2)).catch(() => {});
  await db.delete(providers).where(eq(providers.id, ids.providerId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'billing:hold:*', 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.del(`billing:balance:${userId}`, `auth:key:${keyHash}`);
}

describe('BUG — embeddings 第一个渠道返回 dead_credential 应换渠道（与 chat 一致）', () => {
  it('第 1 渠道 dead_credential → 应换第 2 渠道并返回 200', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser('1000');
    const { token, keyHash } = await createApiKey(userId);
    const ids = await setupModelWithTwoChannels();
    try {
      let calls = 0;
      const ai = {
        // 第 1 次调用（坏渠道）→ dead_credential；第 2 次（好渠道）→ success
        chat: vi.fn(async () => {
          calls += 1;
          if (calls === 1) {
            return {
              status: 'error' as const,
              error: { code: 'dead_credential', message: 'credential invalid', retryable: false, circuitTrip: false },
              durationMs: 5,
            };
          }
          return {
            status: 'success' as const,
            usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, estimated: false },
            body: { object: 'list', data: [{ embedding: [0.1, 0.2], index: 0 }], model: 'embed-mock', usage: { prompt_tokens: 5, total_tokens: 5 } },
            durationMs: 10,
          };
        }),
        chatStream: vi.fn(),
        probe: vi.fn(),
        onEvent: () => () => {},
      } as unknown as Ai;

      const billing = new BillingService(redis, db, 600_000);
      const rateLimiter = new RateLimiter(redis);
      const meter = new MeterProducer(redis);

      const honoApp = createApp(db, ai, billing, rateLimiter, meter, redis);
      const res = await honoApp.request('/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: 'hello world' }),
      });

      // 修复后预期：换渠道成功 → 200，且 ai.chat 被调用 2 次（坏渠道 1 次 + 好渠道 1 次）
      expect(res.status, 'embeddings 遇到 dead_credential 应换渠道而非直接报错').toBe(200);
      expect(ai.chat, '应至少尝试两个渠道').toHaveBeenCalledTimes(2);
    } finally {
      await cleanup(userId, keyHash, ids);
    }
  });
});
