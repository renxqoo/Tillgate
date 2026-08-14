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
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  setupTestModel,
} from '../../testing/helpers.js';

/**
 * 对外隐藏真实上游模型（白标）：响应侧的三处泄漏都必须改写为对外名。
 *   ① 非流式响应体 body.model（直接透传上游 body）
 *   ② 流式每个 SSE 帧的 model 字段
 *   ③ 上游响应缺失时的空信封兜底（原用 realModel）
 * setupTestModel 的对外名/真实名天然可区分（tmodel-xxx / tmodel-xxx-real）。
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

describe('响应侧模型名改写（对外只可见对外名）', () => {
  it('非流式：body.model 回显对外名，真实名不出现', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'mrewr');
    const { token, keyHash } = await createTestApiKey(db, userId, 'mrewr');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, estimated: false, raw: {} },
          durationMs: 5,
          // 上游真实响应体带着真实模型名（且正文里也出现真实名——正文不可误伤）
          body: {
            id: 'chatcmpl-x',
            object: 'chat.completion',
            model: ids.realModel,
            choices: [{ index: 0, message: { role: 'assistant', content: `我是 ${ids.realModel}` }, finish_reason: 'stop' }],
          },
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const parsed = JSON.parse(text) as { model: string };
      expect(parsed.model).toBe(ids.externalModel);
      // 正文里的真实名字符串必须原样保留（只改 model 字段）
      expect(text).toContain(`我是 ${ids.realModel}`);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('非流式：上游 body 缺失时空信封用对外名', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'mrewfb');
    const { token, keyHash } = await createTestApiKey(db, userId, 'mrewfb');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, estimated: false, raw: {} },
          durationMs: 5,
          body: undefined,
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const parsed = (await res.json()) as { model: string };
      expect(parsed.model).toBe(ids.externalModel);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('流式：每个 SSE 帧的 model 都是对外名，真实名不出现', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'mrewst');
    const { token, keyHash } = await createTestApiKey(db, userId, 'mrewst');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const enc = new TextEncoder();
      const frames = [
        `data: {"model":"${ids.realModel}","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n`,
        `data: {"model":"${ids.realModel}","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n`,
        `data: {"model":"${ids.realModel}","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => ({
          stream: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(frames));
              c.close();
            },
          }),
          onEvent: (cb: (e: AiEvent) => void) => {
            cb({
              type: 'success',
              requestId: 'mrew-test',
              channelKey: 'mrew-ch',
              usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, estimated: false, raw: {} },
              durationMs: 5,
            });
          },
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(ids.realModel);
      expect(text.split('"model":"' + ids.externalModel + '"').length - 1).toBe(3);
      expect(text).toContain('data: [DONE]');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
