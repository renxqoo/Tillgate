import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatStreamResult } from '@ai-gateway/ai';
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
} from '../../testing/helpers.js';

/**
 * 审计 P0-3：stream:true 请求在首字节尚未发给客户端时失败且不可换渠道
 * （上游 400/404 等），网关必须返回真实的 HTTP 状态码 + JSON 错误体
 * （OpenAI 官方语义），而不是 200 + SSE 错误帧——标准 SDK 按 HTTP 状态
 * 判定成败，200 会让失败被当成功、在解析层炸掉。
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

describe('P0-3 — 流式首字节前失败返回真实状态码', () => {
  it('上游 400（invalid_request，不可换渠道）→ HTTP 400 JSON 错误体（非 200 SSE）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'p03');
    const { token, keyHash } = await createTestApiKey(db, userId, 'p03');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          // 模拟 create-ai failEarly：含错误帧的流 + 注册时同步重放 failed 事件
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"error":{"code":"invalid_request","message":"bad request"}}\n\n',
                ),
              );
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              cb({
                type: 'failed',
                requestId: 'p03-test',
                channelKey: 'p03ch',
                error: {
                  code: 'invalid_request',
                  message: 'bad request',
                  status: 400,
                  retryable: false,
                  circuitTrip: false,
                  deadCredential: false,
                } as never,
              });
            },
          };
        }),
      });
      const honoApp = buildTestApp(db, redis, ai);
      const res = await honoApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).not.toContain('text/event-stream');
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('invalid_request');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
