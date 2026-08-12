import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Ai } from '@ai-gateway/ai';

/**
 * G-RL 回归：TPM user 维度按模型拆（user:${id}:model:${mappingId}）。
 *
 * 背景：原实现 TPM 维度为 user:${id}（跨模型聚合），同用户并发调两个不同模型时
 *   token 合并计入同一桶 → 撞顶 → 两个模型同时 429。
 * 修复：拆成 user:${id}:model:${mappingId}，每个模型独立享有 TPM 预算。
 *
 * 本测试：预置 user:model TPM 桶超限，发 chat 请求 → 应 429 且 dimension 指向
 *   user:${userId}:model:${mappingId}（而非旧的 user:${userId}）。
 */

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
const usageLogs = dbSchema.usageLogs;
const transactions = dbSchema.transactions;
const requestLogs = dbSchema.requestLogs;
const { BillingService } = await import('../lib/billing.js');
const { RateLimiter } = await import('../lib/rate-limit.js');
const { MeterProducer } = await import('../lib/meter.js');
const { createApp } = await import('../index.js');
const { encrypt } = await import('../lib/crypto.js');

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
    issuer: 'test', subject: 'rl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    identityProvider: 'local', displayName: 'RL', balance,
  }).returning();
  return u!.id;
}
async function createApiKey(userId: number): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({ keyHash, keyPreview: 'ag_****' + token.slice(-4), userId, name: 'rl', status: 0 });
  return { token, keyHash };
}
async function setupModel(): Promise<{ externalModel: string; channelId: number; providerId: number; mappingId: number }> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'rl-model-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db.insert(providers).values({ name: 'rlprov-' + suffix, protocol: 'openai_compatible', baseUrl: 'http://localhost:9999', status: 0 }).returning();
  const [ch] = await db.insert(channels).values({ name: 'rlch-' + suffix, providerId: prov!.id, apiKeyEnc: encrypt('sk-dummy', process.env.ENCRYPTION_KEY!), status: 0 }).returning();
  const [m] = await db.insert(modelMappings).values({ externalName: externalModel, realModel, status: 0, inputPrice: '1000', outputPrice: '2000', cacheInputPrice: '100' }).returning();
  await db.insert(modelChannels).values({ mappingId: m!.id, channelId: ch!.id, priority: 0, weight: 1 });
  return { externalModel, channelId: ch!.id, providerId: prov!.id, mappingId: m!.id };
}
async function cleanup(userId: number, keyHash: string, ids: { channelId: number; providerId: number; mappingId: number }) {
  await db.delete(requestLogs).where(eq(requestLogs.userId, userId)).catch(() => {});
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).catch(() => {});
  await db.delete(transactions).where(eq(transactions.userId, userId)).catch(() => {});
  await db.delete(modelChannels).where(eq(modelChannels.channelId, ids.channelId)).catch(() => {});
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).catch(() => {});
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash)).catch(() => {});
  await db.delete(modelMappings).where(eq(modelMappings.id, ids.mappingId)).catch(() => {});
  await db.delete(channels).where(eq(channels.id, ids.channelId)).catch(() => {});
  await db.delete(providers).where(eq(providers.id, ids.providerId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  await redis.del(`billing:balance:${userId}`, `auth:key:${keyHash}`, `route:cache:v`);
}

describe('G-RL — TPM user 维度按模型拆（user:id:model:mappingId）', () => {
  it('预置 user:model TPM 桶超限 → 429，dimension 指向 user:id:model:mappingId', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser('1000');
    const { token, keyHash } = await createApiKey(userId);
    const ids = await setupModel();
    const minute = Math.floor(Date.now() / 60_000);
    const tpmKey = `tpm:user:${userId}:model:${ids.mappingId}:${minute}`;
    try {
      // 预置 user:model 桶超过 DEFAULT_USER_TPM(1000000)
      await redis.set(tpmKey, '1000001');

      // mock Ai：TPM 限流在调用上游前，chat 不应被调用
      const ai = {
        chat: vi.fn(() => { throw new Error('should not reach upstream — TPM should block first'); }),
        chatStream: vi.fn(),
        probe: vi.fn(),
        onEvent: () => () => {},
      } as unknown as Ai;

      const billing = new BillingService(redis, db, 600_000);
      const rateLimiter = new RateLimiter(redis);
      const meter = new MeterProducer(redis);
      const honoApp = createApp(db, ai, billing, rateLimiter, meter, redis);

      const res = await honoApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hello world' }] }),
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe('rate_limit_exceeded');
      // 关键：dimension 是拆分后的 user:${userId}:model:${mappingId}，不是旧的 user:${userId}
      expect(body.error.message).toContain(`user:${userId}:model:${ids.mappingId}`);
      // 上游未被调用（限流在调用前生效）
      expect(ai.chat).not.toHaveBeenCalled();
    } finally {
      await redis.del(tpmKey, `rl:rpm:user:${userId}`, `rl:rpm:global`).catch(() => {});
      await cleanup(userId, keyHash, ids);
    }
  });
});
