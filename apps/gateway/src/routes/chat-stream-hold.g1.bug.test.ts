import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Ai, ChatStreamResult, AiEvent } from '@ai-gateway/ai';

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
 * G1 实证：流式成功但无 usage 且 bytesRelayed=0 → 跳过计量 + hold 不释放 → 资损。
 *
 * chat-completions.ts 流式 success 事件分支（line 285-294）：
 *   if (e.type === 'success') {
 *     const usage = e.usage ?? estimateStreamUsage(body, e.bytesRelayed ?? 0);
 *     if (usage) { void enqueueMeter(...); }   // 计量入队
 *     else { logger.warn(..., 'skip metering'); }  // ← 跳过计量
 *   }
 *   ... settled = true (line 305)  // 无论是否计量都标 settled
 *
 * 问题：当 success 事件 usage=undefined 且 bytesRelayed=0 时（真实场景：上游返回 200 但
 *   流体为空、或 usage 帧缺失 + 无内容字节），计量被跳过。但 settled 已置 true →
 *   finally 块（line 375）不释放 hold → hold 残留到 TTL（10min），余额被错误占用。
 *   更严重：usage_logs 永不写入 → 即便有实际输入 token 也完全漏计费（资损）。
 *
 * 本测试：mock Ai 返回一个「success 事件 usage=undefined + bytesRelayed=0」的流，
 * 观察 enqueueMeter 是否被调用、hold 是否被释放。
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
    issuer: 'test', subject: 'g1-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    identityProvider: 'local', displayName: 'G1', balance,
  }).returning();
  return u!.id;
}
async function createApiKey(userId: number): Promise<{ token: string; keyHash: string }> {
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await db.insert(apiKeys).values({ keyHash, keyPreview: 'ag_****' + token.slice(-4), userId, name: 'g1', status: 0 });
  return { token, keyHash };
}
async function setupModel(): Promise<{ externalModel: string; channelId: number; providerId: number; mappingId: number }> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'g1-model-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db.insert(providers).values({ name: 'g1prov-' + suffix, protocol: 'openai_compatible', baseUrl: 'http://localhost:9999', status: 0 }).returning();
  const [ch] = await db.insert(channels).values({ name: 'g1ch-' + suffix, providerId: prov!.id, apiKeyEnc: encrypt('sk-dummy', process.env.ENCRYPTION_KEY!), status: 0 }).returning();
  const [m] = await db.insert(modelMappings).values({ externalName: externalModel, realModel, status: 0, inputPrice: '1000', outputPrice: '2000', cacheInputPrice: '100' }).returning();
  await db.insert(modelChannels).values({ mappingId: m!.id, channelId: ch!.id, priority: 0, weight: 1 });
  return { externalModel, channelId: ch!.id, providerId: prov!.id, mappingId: m!.id };
}
async function cleanup(userId: number, keyHash: string, ids: { channelId: number; providerId: number; mappingId: number }) {
  const usageLogs = dbSchema.usageLogs;
  const transactions = dbSchema.transactions;
  const requestLogs = dbSchema.requestLogs;
  // 等 worker 异步结算落 usage_logs（避免清理时 FK 引用还在），最多等 3s
  for (let i = 0; i < 15; i++) {
    const pending = await db.select({ id: usageLogs.id }).from(usageLogs).where(eq(usageLogs.userId, userId)).limit(1);
    // 等到无新增或已有记录（worker 可能不落，syncSettle 已落）
    if (i > 2) break;
    await new Promise((r) => setTimeout(r, 200));
    void pending;
  }
  // FK 顺序：request_logs/usage_logs 引用 api_keys/users → 先删（按 userId + apiKeyId 双重清理）
  await db.delete(requestLogs).where(eq(requestLogs.userId, userId)).catch(() => {});
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).catch(() => {});
  await db.delete(transactions).where(eq(transactions.userId, userId)).catch(() => {});
  await db.delete(modelChannels).where(eq(modelChannels.channelId, ids.channelId)).catch(() => {});
  // usage_logs.api_key_id 引用 api_keys → 再清一次可能新落的 usage_logs
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId)).catch(() => {});
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash)).catch(() => {});
  await db.delete(modelMappings).where(eq(modelMappings.id, ids.mappingId)).catch(() => {});
  await db.delete(channels).where(eq(channels.id, ids.channelId)).catch(() => {});
  await db.delete(providers).where(eq(providers.id, ids.providerId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  await redis.del(`billing:balance:${userId}`, `auth:key:${keyHash}`, `route:cache:v`);
}

describe('G1 — 流式 success 无 usage + bytesRelayed=0 → 跳过计量 + hold 不释放', () => {
  it('mock 上游返回 success(usage=undefined, bytesRelayed=0) → enqueueMeter 未调用，hold 残留', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createUser('1000');
    const { token, keyHash } = await createApiKey(userId);
    const ids = await setupModel();
    const reqId = randomUUID();
    try {
      // mock Ai：chatStream 返回一个流，onEvent 注册后立即同步发 success（usage=undefined, bytesRelayed=0）
      const ai = {
        chat: vi.fn(),
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          const stream = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              // 同步发 success（模拟 relay-stream 流尾 done→success），无 usage、0 字节
              cb({ type: 'success', requestId: reqId, channelKey: 'g1ch', usage: undefined, durationMs: 10, bytesRelayed: 0 } as AiEvent);
            },
          };
        }),
        probe: vi.fn(),
        onEvent: () => () => {},
      } as unknown as Ai;

      const billing = new BillingService(redis, db, 600_000);
      // spy enqueue：替换 meter 的 enqueue 观察是否被调用
      const rateLimiter = new RateLimiter(redis);
      const meter = new MeterProducer(redis);
      let enqueueCalled = false;
      const origEnqueue = meter.enqueue.bind(meter);
      meter.enqueue = async (data: unknown) => { enqueueCalled = true; return origEnqueue(data as never); };

      const honoApp = createApp(db, ai, billing, rateLimiter, meter, redis);
      const res = await honoApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }),
      });
      console.log(`   G1: HTTP ${res.status}, enqueueCalled=${enqueueCalled}`);
      // 期望（修复后）：即便无 usage 也应结算（至少释放 hold，或按估算计费）
      // 当前（BUG）：enqueueMeter 未调用 + hold 残留（settled=true 不释放）
      expect(enqueueCalled).toBe(true); // 当前 FAIL：false（跳过计量）
    } finally {
      await cleanup(userId, keyHash, ids);
    }
  });
});
