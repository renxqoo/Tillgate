import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  billingRequests,
  channels,
  modelChannels,
  modelMappings,
  providers,
} from '@ai-gateway/db/schema';
import { Decimal, estimateMaxCost } from '@ai-gateway/money';
import { estimateInputTokens, type UpstreamError } from '@ai-gateway/ai';
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
import { createBillingDispatcher } from '../../services/billing/billing-dispatcher.js';

/**
 * 候选定价（fallback 定价错配根治）：
 *   1. 预扣按最贵候选（主模型 + fallback）估算——fallback 更贵时不会结算透支
 *   2. 计量 job 携带实际成功渠道对应 realModel 的价格快照 + mappingId（真实成本入账）
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

interface ModelFixture {
  externalModel: string;
  mainReal: string;
  fbExternal: string;
  fbReal: string;
  mainMappingId: number;
  fbMappingId: number;
  mainChannelId: number;
  fbChannelId: number;
  providerId: number;
}

/** 主模型（便宜）+ fallback 模型（贵 5 倍），各绑一个渠道 */
async function setupFallbackModels(encryptionKey: string): Promise<ModelFixture> {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const externalModel = 'fb-main-' + suffix;
  const mainReal = externalModel + '-real';
  const fbExternal = 'fb-fallback-' + suffix;
  const fbReal = fbExternal + '-real';

  const [prov] = await db
    .insert(providers)
    .values({
      name: 'fb-prov-' + suffix,
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:9999',
      status: 0,
    })
    .returning();
  const [mainCh] = await db
    .insert(channels)
    .values({
      name: 'fb-main-ch-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-main', encryptionKey),
      status: 0,
      upstreamBudget: '1000000',
    })
    .returning();
  const [fbCh] = await db
    .insert(channels)
    .values({
      name: 'fb-fb-ch-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-fb', encryptionKey),
      status: 0,
      upstreamBudget: '1000000',
    })
    .returning();
  const [main] = await db
    .insert(modelMappings)
    .values({
      externalName: externalModel,
      realModel: mainReal,
      status: 0,
      inputPrice: '1000',
      outputPrice: '2000',
      cacheInputPrice: '100',
      fallbackModels: [fbExternal],
    })
    .returning();
  const [fb] = await db
    .insert(modelMappings)
    .values({
      externalName: fbExternal,
      realModel: fbReal,
      status: 0,
      inputPrice: '5000', // fallback 贵 5 倍
      outputPrice: '10000',
      cacheInputPrice: '500',
    })
    .returning();
  await db.insert(modelChannels).values([
    { mappingId: main!.id, channelId: mainCh!.id, priority: 0, weight: 1 },
    { mappingId: fb!.id, channelId: fbCh!.id, priority: 0, weight: 1 },
  ]);
  return {
    externalModel,
    mainReal,
    fbExternal,
    fbReal,
    mainMappingId: main!.id,
    fbMappingId: fb!.id,
    mainChannelId: mainCh!.id,
    fbChannelId: fbCh!.id,
    providerId: prov!.id,
  };
}

async function cleanupFixture(userId: number, keyHash: string, f: ModelFixture): Promise<void> {
  await cleanupTestData(db, redis, userId, keyHash, { providerId: f.providerId });
  await db
    .delete(modelChannels)
    .where(eq(modelChannels.mappingId, f.fbMappingId))
    .catch(() => {});
  await db
    .delete(modelMappings)
    .where(eq(modelMappings.id, f.fbMappingId))
    .catch(() => {});
  await db
    .delete(channels)
    .where(eq(channels.id, f.fbChannelId))
    .catch(() => {});
}

describe('候选定价：预扣按最贵候选 + 计量携带实际成功渠道价格', () => {
  it('主模型失败 → fallback 成功：hold = fallback 估算，计量用 fallback 价格快照', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'fbpricing');
    const { token, keyHash } = await createTestApiKey(db, userId, 'fbpricing');
    const f = await setupFallbackModels(process.env.ENCRYPTION_KEY!);
    const reqBody = {
      model: f.externalModel,
      messages: [{ role: 'user', content: 'hello fallback pricing' }],
      max_tokens: 100,
    };
    try {
      // mock ai：主模型渠道网络失败（可换渠道），fallback 渠道成功
      const ai = makeMockAi({
        chat: vi.fn(async (input: { ctx: { model: string } }) => {
          if (input.ctx.model === f.mainReal) {
            return { status: 'error' as const, error: networkError(), durationMs: 5 };
          }
          return {
            status: 'success' as const,
            usage: {
              inputTokens: 20,
              cachedInputTokens: 0,
              outputTokens: 50,
              estimated: false,
              raw: {},
            },
            body: { id: 'mock', object: 'chat.completion', choices: [] },
            durationMs: 10,
          };
        }),
      });

      const dispatcher = createBillingDispatcher(redis);
      let wakeupRequestId: string | null = null;
      const origWake = dispatcher.wake.bind(dispatcher);
      dispatcher.wake = async (requestId) => {
        wakeupRequestId = requestId;
        return origWake(requestId);
      };

      const app = buildTestApp(db, redis, ai, undefined, undefined, dispatcher);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      expect(res.status).toBe(200);
      expect(ai.chat).toHaveBeenCalledTimes(2); // 主渠道失败 → fallback 渠道

      // 预扣按最贵候选（fallback 5 倍价）估算；输入敞口用权威估算（estimateInputTokens，CJK 感知）
      const inputEstimate = estimateInputTokens(reqBody);
      const fbEstimate = estimateMaxCost({
        estimatedInputTokens: inputEstimate,
        maxOutputTokens: 100,
        inputPrice: '5000',
        outputPrice: '10000',
        coefficient: '1.0',
      });
      const expectedHold = fbEstimate;
      await new Promise((r) => setTimeout(r, 100));
      const billingRow = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
        columns: { reservedAmount: true, status: true, receipt: true, requestId: true },
      });
      expect(billingRow).toBeDefined();
      // processing = 共享环境里真实 worker 已抢先 claim（本测试断言的价格快照在 claim 前已写定）
      expect(['settlement_pending', 'processing', 'settled']).toContain(billingRow?.status);
      expect(new Decimal(billingRow?.reservedAmount ?? '0').equals(expectedHold)).toBe(true);

      // 收据先落 DB；队列只收到 requestId。
      const receipt = billingRow?.receipt as {
        realModel: string;
        mappingId: number;
        inputPrice: string;
        outputPrice: string;
        cacheInputPrice: string;
        externalModel: string;
      };
      expect(wakeupRequestId).toBe(billingRow?.requestId);
      expect(receipt.realModel).toBe(f.fbReal);
      expect(receipt.mappingId).toBe(f.fbMappingId);
      // DB numeric 返回全精度字符串（'5000.000000000000000000'），按数值比较
      expect(new Decimal(receipt.inputPrice).equals('5000')).toBe(true);
      expect(new Decimal(receipt.outputPrice).equals('10000')).toBe(true);
      expect(new Decimal(receipt.cacheInputPrice).equals('500')).toBe(true);
      // 对外模型名保持用户请求的
      expect(receipt.externalModel).toBe(f.externalModel);
    } finally {
      await cleanupFixture(userId, keyHash, f);
    }
  });
});
