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
} from '../../testing/helpers.js';

/**
 * 入站协议端点 e2e：外部线格式 → 规范形管线 → 外部线格式响应。
 * mock Ai 只说规范形（管线内部恒为规范形的契约验证）。
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

/** 规范形非流式 chat 响应 */
const CANONICAL_BODY = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1700000000,
  model: 'REAL',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/** 规范形 SSE 流（role + content + finish + usage + [DONE]） */
function canonicalSseStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = [
    { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: 'REAL', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: 'REAL', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
    { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: 'REAL', choices: [{ index: 0, delta: { content: 'lo!' }, finish_reason: null }] },
    { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: 'REAL', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ];
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

function mockAi() {
  return makeMockAi({
    chat: vi.fn(async () => ({
      status: 'success' as const,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false, raw: {} },
      body: CANONICAL_BODY,
      durationMs: 5,
    })),
    chatStream: vi.fn(async () => {
      const stream = canonicalSseStream();
      return {
        stream,
        onEvent: (cb: (e: unknown) => void) => {
          // 流完成即发 success 终态（真实契约：relay 完成语义→事件；计费收尾依赖它）
          queueMicrotask(() => {
            cb({
              type: 'success',
              requestId: 'mock',
              channelKey: 'mock://upstream',
              usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, estimated: false, raw: {} },
              durationMs: 6,
              terminated: undefined,
              bytesRelayed: 120,
              doneSentinel: true,
              terminalFrame: true,
            });
          });
        },
      } as never;
    }),
  });
}

async function readStream(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe.each([true, false])('入站协议端点 e2e（stream=%s）', (stream) => {
  it('/v1/messages：claude 请求 → 规范形管线 → claude 响应', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'clde');
    const { token, keyHash } = await createTestApiKey(db, userId, 'clde');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const app = buildTestApp(db, redis, mockAi());
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: ids.externalModel,
          max_tokens: 100,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          ...(stream ? { stream: true } : {}),
        }),
      });
      expect(res.status).toBe(200);
      if (stream) {
        const text = await readStream(res);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(text).toContain('event: message_start');
        expect(text).toContain('"type":"text_delta","text":"Hel"');
        expect(text).toContain('"type":"text_delta","text":"lo!"');
        expect(text).toContain('event: message_stop');
      } else {
        const json = await readJson(res);
        expect(json.type).toBe('message');
        expect(json.role).toBe('assistant');
        expect((json.content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'text', text: 'Hello!' });
        expect(json.stop_reason).toBe('end_turn');
      }
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('/v1beta/models/:model:generateContent：gemini 原生 → 规范形 → gemini 响应', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'gme2e');
    const { token, keyHash } = await createTestApiKey(db, userId, 'gme2e');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const app = buildTestApp(db, redis, mockAi());
      const action = stream ? 'streamGenerateContent' : 'generateContent';
      const res = await app.request(`/v1beta/models/${ids.externalModel}:${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      });
      expect(res.status).toBe(200);
      if (stream) {
        const text = await readStream(res);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(text).toContain('"parts":[{"text":"Hel"}]');
        expect(text).toContain('"finishReason":"STOP"');
        expect(text).not.toContain('[DONE]');
      } else {
        const json = await readJson(res);
        const candidates = json.candidates as Array<Record<string, unknown>>;
        const first = candidates[0] as Record<string, unknown> | undefined;
        expect(((first?.content as Record<string, unknown> | undefined)?.parts)).toEqual([{ text: 'Hello!' }]);
        expect(candidates[0]?.finishReason).toBe('STOP');
        expect((json.usageMetadata as Record<string, unknown>).promptTokenCount).toBe(10);
      }
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('/v1/responses 与 /v1/completions：OpenAI 家族入站翻译', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'rspe');
    const { token, keyHash } = await createTestApiKey(db, userId, 'rspe');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const app = buildTestApp(db, redis, mockAi());
      // responses 非流式
      const r1 = await app.request('/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, input: 'hi', instructions: 'be nice' }),
      });
      expect(r1.status).toBe(200);
      const j1 = await readJson(r1);
      expect(j1.object).toBe('response');
      expect(j1.status).toBe('completed');
      // completions 非流式
      const r2 = await app.request('/v1/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ids.externalModel, prompt: 'hi' }),
      });
      expect(r2.status).toBe(200);
      const j2 = await readJson(r2);
      expect(j2.object).toBe('text_completion');
      expect((j2.choices as Array<Record<string, unknown>>)[0]?.text).toBe('Hello!');
      if (stream) {
        const r3 = await app.request('/v1/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: ids.externalModel, prompt: 'hi', stream: true }),
        });
        const text = await readStream(r3);
        expect(text).toContain('"object":"text_completion"');
        expect(text).toContain('"text":"Hel"');
        expect(text).toContain('data: [DONE]');
      }
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});

describe('/v1/models 三格式', () => {
  it('OpenAI / Anthropic / Gemini 头检测输出对应形态', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '100000', 'mdls');
    const { token, keyHash } = await createTestApiKey(db, userId, 'mdls');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      await redis.incr('route:cache:v'); // bump 版本：models 列表缓存按版本隔离
      const app = buildTestApp(db, redis, mockAi());
      const h = { authorization: `Bearer ${token}` };
      const openai = await readJson(await app.request('/v1/models', { headers: h }));
      expect(openai.object).toBe('list');
      expect((openai.data as unknown[]).some((m) => (m as Record<string, unknown>).id === ids.externalModel)).toBe(true);
      const anthropic = await readJson(await app.request('/v1/models', { headers: { ...h, 'anthropic-version': '2023-06-01' } }));
      expect(Array.isArray(anthropic.data)).toBe(true);
      const gemini = await readJson(await app.request('/v1/models', { headers: { ...h, 'x-goog-api-key': 'any' } }));
      expect(Array.isArray(gemini.models)).toBe(true);
      expect((gemini.models as unknown[]).some((m) => (m as Record<string, unknown>).name === `models/${ids.externalModel}`)).toBe(true);
      // 详情端点
      const detail = await app.request(`/v1/models/${ids.externalModel}`, { headers: h });
      expect(detail.status).toBe(200);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});

