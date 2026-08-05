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
 * BUG #7 — embeddings.ts 路径与 chat-completions.ts 的非流式 success 分支同形：
 *   if (result.status === 'success') {
 *     if (result.usage) { void meter.enqueue(...); }
 *     // ← 无 else 兜底（流式 G1 修复做了，embeddings 没做）
 *     settled = true;
 *     return c.json(...);
 *   }
 * 触发：上游返回 200 + JSON 无 usage 字段 + estimateUsage 算不出 → result.usage=undefined
 * 后果：enqueue 不被调用 + settled=true → finally 不释放 → hold 残留 10min + 漏计费
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
    issuer: 'test', subject: 'emb-bug-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    identityProvider: 'local', displayName: 'EmbeddingsBug', balance,
  }).returning();
  return u!.id;
}
async function createApiKey(userId: number): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({ keyHash, keyPreview: 'ag_****' + token.slice(-4), userId, name: 'emb-bug', status: 0 });
  return { token, keyHash };
}
async function setupModel(): Promise<{ externalModel: string; channelId: number; providerId: number; mappingId: number }> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'emb-bug-model-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db.insert(providers).values({ name: 'emb-bug-prov-' + suffix, protocol: 'openai_compatible', baseUrl: 'http://localhost:9999', status: 0 }).returning();
  const [ch] = await db.insert(channels).values({ name: 'emb-bug-ch-' + suffix, providerId: prov!.id, apiKeyEnc: encrypt('sk-dummy', process.env.ENCRYPTION_KEY!), status: 0 }).returning();
  const [m] = await db.insert(modelMappings).values({ externalName: externalModel, realModel, status: 0, inputPrice: '1000', outputPrice: '0', cacheInputPrice: '100' }).returning();
  await db.insert(modelChannels).values({ mappingId: m!.id, channelId: ch!.id, priority: 0, weight: 1 });
  return { externalModel, channelId: ch!.id, providerId: prov!.id, mappingId: m!.id };
}
async function cleanup(userId: number, keyHash: string, ids: { channelId: number; providerId: number; mappingId: number }) {
  const usageLogs = dbSchema.usageLogs;
  const transactions = dbSchema.transactions;
  const requestLogs = dbSchema.requestLogs;
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
  // 清掉所有 hold keys（无法预知 requestId）
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'billing:hold:*', 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  await redis.del(`billing:balance:${userId}`, `auth:key:${keyHash}`);
}

describe('BUG #7 — embeddings.ts 同样存在「非流式 success 无 usage → 不入队 + hold 残留」', () => {
  it('mock 上游返回 success(usage=undefined) → enqueue 未调用', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser('1000');
    const { token, keyHash } = await createApiKey(userId);
    const ids = await setupModel();
    try {
      const ai = {
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: undefined, // 上游返回无 usage 字段
          body: { object: 'list', data: [{ embedding: [0.1, 0.2], index: 0 }], model: 'embed-mock', usage: { prompt_tokens: 0, total_tokens: 0 } },
          durationMs: 10,
        })),
        chatStream: vi.fn(),
        probe: vi.fn(),
        onEvent: () => () => {},
      } as unknown as Ai;

      const billing = new BillingService(redis, db, 600_000);
      const rateLimiter = new RateLimiter(redis);
      const meter = new MeterProducer(redis);

      let enqueueCalled = false;
      const origEnqueue = meter.enqueue.bind(meter);
      meter.enqueue = async (data: unknown) => { enqueueCalled = true; return origEnqueue(data as never); };

      const honoApp = createApp(db, ai, billing, rateLimiter, meter, redis);
      const res = await honoApp.request('/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: 'hello world' }),
      });

      expect(res.status).toBe(200);
      // 修复后预期：enqueue 被调用（即便 usage=undefined 也要按输入估算入队）
      expect(enqueueCalled).toBe(true);
      // 注：usage_logs 写入由 worker 异步结算完成（需 worker 进程），本测试聚焦
      // gateway 侧 bug 指标（enqueueCalled）。worker 结算闭环由端到端测试覆盖。
    } finally {
      await cleanup(userId, keyHash, ids);
    }
  });
});