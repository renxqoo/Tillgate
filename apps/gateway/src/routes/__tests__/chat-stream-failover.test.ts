import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import type { AiEvent, ChatStreamResult, UpstreamError } from '@ai-gateway/ai';
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
 * 流式 failEarly 换渠道：ai 包契约——流开始前失败返回含错误帧的流，
 * 并在 onEvent 注册时同步重放 failed 终态事件。管线据此换下一个渠道。
 * 本测试锁死该隐式时序契约（换渠道成功 → 200 SSE）。
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

/** 模型绑两个渠道（候选循环才有「换渠道」可言） */
async function setupModelWithTwoChannels(encryptionKey: string) {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 4);
  const externalModel = 'sfo-' + suffix;
  const realModel = externalModel + '-real';
  const [prov] = await db
    .insert(providers)
    .values({
      name: 'sfp-' + suffix,
      protocol: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      status: 0,
    })
    .returning();
  const [ch1] = await db
    .insert(channels)
    .values({
      name: 'sfch1-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-1', encryptionKey),
      status: 0,
    })
    .returning();
  const [ch2] = await db
    .insert(channels)
    .values({
      name: 'sfch2-' + suffix,
      providerId: prov!.id,
      apiKeyEnc: encrypt('sk-2', encryptionKey),
      status: 0,
    })
    .returning();
  const [m] = await db
    .insert(modelMappings)
    .values({
      externalName: externalModel,
      realModel,
      status: 0,
      inputPrice: '1000',
      outputPrice: '2000',
      cacheInputPrice: '100',
    })
    .returning();
  await db.insert(modelChannels).values([
    { mappingId: m!.id, channelId: ch1!.id, priority: 0, weight: 1 },
    { mappingId: m!.id, channelId: ch2!.id, priority: 0, weight: 1 },
  ]);
  return {
    externalModel,
    channelId1: ch1!.id,
    channelId2: ch2!.id,
    providerId: prov!.id,
    mappingId: m!.id,
  };
}

describe('流式 failEarly（流开始前失败）换渠道', () => {
  it('渠道1 failEarly(network) → 重放 failed → 换渠道2 → 200 SSE', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'streamfo');
    const { token, keyHash } = await createTestApiKey(db, userId, 'streamfo');
    const ids = await setupModelWithTwoChannels(process.env.ENCRYPTION_KEY!);
    try {
      let calls = 0;
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          calls += 1;
          if (calls === 1) {
            // 流开始前失败：含错误帧的流 + onEvent 注册时同步重放 failed
            const stream = new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode('data: {"error":{"code":"network"}}\n\n'));
                c.close();
              },
            });
            return {
              stream,
              onEvent: (cb: (e: AiEvent) => void) => {
                cb({
                  type: 'failed',
                  requestId: 'fo-test',
                  channelKey: 'ch1',
                  error: networkError(),
                });
              },
            };
          }
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              cb({
                type: 'success',
                requestId: 'fo-test',
                channelKey: 'ch2',
                usage: {
                  inputTokens: 10,
                  cachedInputTokens: 0,
                  outputTokens: 5,
                  estimated: false,
                  raw: {},
                },
                durationMs: 5,
              });
            },
          };
        }),
      });

      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(calls).toBe(2); // 渠道1 failEarly → 换渠道2
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
