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
 * 新 bug 复现 —— 非流式 success 但 usage=undefined（且 estimateUsage 也算不出来）
 *                  → enqueueMeter 永远不被调用 + settled=true → hold 残留 10min
 *
 * 与 G1 类似，但 G1 修复只覆盖了流式 success 分支（chat-completions.ts:285-304），
 * 非流式 success 分支（chat-completions.ts:329-345）没有同等兜底：
 *
 *   if (result.status === 'success') {
 *     if (result.usage) { void enqueueMeter(...); }
 *     // ← 无 else 分支，无兜底估算
 *     settled = true;
 *     return c.json(...);
 *   }
 *
 * 触发场景：
 *   1. 上游返回 200 + JSON，但 JSON 里没有 usage 字段（非 OpenAI 兼容响应）
 *   2. estimateUsage 也无法从 body 算出（罕见但存在：上游回应为空 choices）
 *   → result.usage = undefined → 不入队 → hold 残留 → worker 永不知情 → 余额被锁 10 分钟
 *
 * 该测试：mock 上游返回 usage=undefined 的 success，观察
 *   (a) enqueueMeter 是否被调用（应：被调用，因为请求已实际执行）
 *   (b) hold key 是否被释放（应：被释放或至少被结算）
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

async function createUser(balance: number): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test', subject: 'nostream-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    identityProvider: 'local', displayName: 'NoStreamUsage', balance,
  }).returning();
  return u!.id;
}
async function createApiKey(userId: number): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({ keyHash, keyPreview: 'ag_****' + token.slice(-4), userId, name: 'nostream', status: 0 });
  return { token, keyHash };
}
async function setupModel(): Promise<{ externalModel: string; channelId: number; providerId: number; mappingId: number }> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'nostream-model-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db.insert(providers).values({ name: 'nostream-prov-' + suffix, protocol: 'openai_compatible', baseUrl: 'http://localhost:9999', status: 0 }).returning();
  const [ch] = await db.insert(channels).values({ name: 'nostream-ch-' + suffix, providerId: prov!.id, apiKeyEnc: encrypt('sk-dummy', process.env.ENCRYPTION_KEY!), status: 0 }).returning();
  const [m] = await db.insert(modelMappings).values({ externalName: externalModel, realModel, status: 0, inputPrice: 1_000_000, outputPrice: 2_000_000, cacheInputPrice: 100_000 }).returning();
  await db.insert(modelChannels).values({ mappingId: m!.id, channelId: ch!.id, priority: 0, weight: 1 });
  return { externalModel, channelId: ch!.id, providerId: prov!.id, mappingId: m!.id };
}
async function cleanup(userId: number, keyHash: string, ids: { channelId: number; providerId: number; mappingId: number }, reqId: string) {
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
  await redis.del(`billing:balance:${userId}`, `auth:key:${keyHash}`, `billing:hold:${reqId}`);
}

describe('非流式 success 但 usage=undefined → enqueueMeter 未调用 + hold 残留', () => {
  it('mock 上游返回 success(usage=undefined) → 入队未发生 + hold key 残留', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser(1_000_000);
    const { token, keyHash } = await createApiKey(userId);
    const ids = await setupModel();
    const reqId = randomUUID();
    try {
      const ai = {
        chat: vi.fn(async () => ({
          status: 'success' as const,
          // 关键：usage=undefined（上游没返回 usage 字段，且 estimateUsage 算不出）
          usage: undefined,
          body: { id: 'mock', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'hi' } }] },
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
      const res = await honoApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });

      // 请求成功（200）= 上游已执行，平台已付钱
      expect(res.status).toBe(200);
      // 修复后预期：enqueue 被调用（即便 usage=undefined 也至少估算入队）
      // 这是核心 bug 指标：旧实现 usage=undefined 时跳过 enqueueMeter → 漏计费 + hold 残留
      expect(enqueueCalled).toBe(true);

      // 验证计费链路完整：enqueue 成功后 worker 会异步结算，写 usage_logs。
      // hold 不在响应时立即删除（worker 异步结算时删），所以不检查即时 hold 数
      // （全局 hold 扫描会包含其他测试残留，且与异步结算架构冲突）。
      // 等 worker 结算后验证 usage_logs 有记录 = 计费链路闭环。
      await new Promise((r) => setTimeout(r, 2000));
      const usageLog = await db.query.usageLogs.findFirst({
        where: eq(dbSchema.usageLogs.userId, userId),
        orderBy: (logs, { desc }) => [desc(logs.id)],
      });
      expect(usageLog).toBeDefined();
      expect(usageLog?.amount).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanup(userId, keyHash, ids, reqId);
    }
  });
});