import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  setupTestModel,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  waitForBillingStatus,
  BILLING_SETTLE_STATES,
} from '../../testing/helpers.js';
import { eq } from 'drizzle-orm';
import { billingRequests } from '@ai-gateway/db/schema';

/**
 * 模态端点 e2e：按张/按秒/按次/按字符计费落账 + 二进制透传 + multipart。
 * mock Ai 走规范形管线契约（非流式 + 可选 rawBody 二进制）。
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

async function receiptOf(userId: number): Promise<Record<string, any> | undefined> {
  await waitForBillingStatus(db, userId, BILLING_SETTLE_STATES, 5000);
  const row = await db.query.billingRequests.findFirst({
    where: eq(billingRequests.userId, userId),
    columns: { receipt: true },
  });
  return row?.receipt as Record<string, any> | undefined;
}

function imageAi(nImages: number) {
  return makeMockAi({
    chat: vi.fn(async () => ({
      status: 'success' as const,
      usage: undefined,
      body: { created: 1700000000, data: Array.from({ length: nImages }, () => ({ url: 'https://x/img.png' })) },
      durationMs: 6,
    })),
  });
}

function speechAi() {
  return makeMockAi({
    chat: vi.fn(async () => ({
      status: 'success' as const,
      usage: undefined,
      durationMs: 6,
      rawBody: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]),
      rawContentType: 'audio/wav',
    })),
  });
}

describe('模态端点 e2e', () => {
  it('images generations：n=2 × unitPrice 0.05 → 收据 units=2；响应透传', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100', 'imge');
    const { token, keyHash } = await createTestApiKey(db, userId, 'imge');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      pricingUnit: 'image',
      unitPrice: '0.05',
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    try {
      const app = buildTestApp(db, redis, imageAi(2));
      const res = await app.request('/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, prompt: 'a cat', n: 2, size: '1024x1024' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data?: unknown[] };
      expect(body.data).toHaveLength(2);
      const receipt = await receiptOf(userId);
      expect(receipt?.usage?.units).toBe(2);
      expect(receipt?.unitPrice ?? '0').not.toBe('0');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('audio speech：二进制透传 + 按字符计费（4 字符 → units=4）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100', 'spch');
    const { token, keyHash } = await createTestApiKey(db, userId, 'spch');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      pricingUnit: 'char',
      unitPrice: '0.0001',
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    try {
      const app = buildTestApp(db, redis, speechAi());
      const res = await app.request('/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: '你好世界', voice: 'alloy' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/wav');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes[0]).toBe(0x52); // RIFF 头原样
      const receipt = await receiptOf(userId);
      expect(receipt?.usage?.units).toBe(4);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('rerank：按次计费 units=1；moderations 同构', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100', 'rnke');
    const { token, keyHash } = await createTestApiKey(db, userId, 'rnke');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      pricingUnit: 'request',
      unitPrice: '0.001',
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    try {
      const app = buildTestApp(
        db,
        redis,
        makeMockAi({
          chat: vi.fn(async () => ({
            status: 'success' as const,
            usage: undefined,
            body: { id: 'rr', model: ids.externalModel, results: [{ index: 0, relevance_score: 0.9 }] },
            durationMs: 4,
          })),
        }),
      );
      const res = await app.request('/v1/rerank', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, query: 'hi', documents: ['a', 'b'] }),
      });
      expect(res.status).toBe(200);
      const receipt = await receiptOf(userId);
      expect(receipt?.usage?.units).toBe(1);
      const res2 = await app.request('/v1/moderations', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: 'check' }),
      });
      expect(res2.status).toBe(200);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('audio transcriptions（multipart）：秒数计量 + FormData 重组直传上游', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100', 'stte');
    const { token, keyHash } = await createTestApiKey(db, userId, 'stte');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      pricingUnit: 'second',
      unitPrice: '0.001',
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
    });
    let seenForm: FormData | null = null;
    try {
      const app = buildTestApp(
        db,
        redis,
        makeMockAi({
          chat: vi.fn(async (input: { request: unknown }) => {
            seenForm = input.request as FormData;
            return {
              status: 'success' as const,
              usage: undefined,
              body: { text: 'hello world' },
              durationMs: 5,
            };
          }),
        }),
      );
      // 构造 1 秒 WAV（16000Hz 16bit mono → 32000B data）
      const wav = new Uint8Array(44 + 32000);
      const v = new DataView(wav.buffer);
      const tag = (o: number, t: string) => { for (let i = 0; i < t.length; i++) wav[o + i] = t.charCodeAt(i); };
      tag(0, 'RIFF'); v.setUint32(4, 36 + 32000, true); tag(8, 'WAVE');
      tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      tag(36, 'data'); v.setUint32(40, 32000, true);

      const form = new FormData();
      form.append('model', ids.externalModel);
      form.append('file', new File([wav], 'audio.wav', { type: 'audio/wav' }));
      const res = await app.request('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: 'hello world' });
      // 上游收到重组 FormData（文件字段与 model 原样）
      expect(seenForm).toBeInstanceOf(FormData);
      expect(seenForm!.get('model')).toBe(ids.externalModel);
      expect(seenForm!.get('file')).toBeInstanceOf(File);
      const receipt = await receiptOf(userId);
      expect(receipt?.usage?.units).toBe(1); // 32000B @32000B/s = 1s
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});

