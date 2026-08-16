import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestCtx } from '@ai-gateway/ai';
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
import { inferenceEndpoints } from '../inference-endpoints.js';

/**
 * 端点注册表锁定测试（下游单一真相）：
 * 推理端点表（inferenceEndpoints）是鉴权挂载与路由注册的唯一来源——
 * 表内每个 path 必须：无鉴权 401（鉴权中间件已覆盖）、有鉴权到达管线
 * （mockAi 收到 ctx.endpoint 与 kind 一致）。
 * 新增端点若漏挂鉴权或漏注册路由，本测试即红。
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

/** 按 kind 生成合法请求体 */
function bodyFor(kind: string, model: string): Record<string, unknown> {
  return kind === 'embeddings'
    ? { model, input: 'hello' }
    : { model, messages: [{ role: 'user', content: 'hi' }], stream: false };
}

describe('推理端点注册表（inferenceEndpoints 单一真相）', () => {
  it('注册表覆盖当前对外面：chat 与 embeddings', () => {
    expect(inferenceEndpoints.map((e) => e.path)).toEqual([
      '/v1/chat/completions',
      '/v1/embeddings',
    ]);
  });

  for (const endpoint of inferenceEndpoints) {
    it(`${endpoint.path}：无鉴权 401（鉴权中间件由表驱动挂载）`, async () => {
      if (!connected) return it.skip('no DB');
      const app = buildTestApp(db, redis, makeMockAi());
      const res = await app.request(endpoint.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyFor(endpoint.kind, 'whatever')),
      });
      expect(res.status).toBe(401);
    });

    it(`${endpoint.path}：有鉴权到达管线，ctx.endpoint 与 kind 一致`, async () => {
      if (!connected) return it.skip('no DB');
      const userId = await createTestUser(db, '1000', 'epreg');
      const { token, keyHash } = await createTestApiKey(db, userId, 'epreg');
      const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
      try {
        const seenEndpoints: Array<RequestCtx['endpoint']> = [];
        const ai = makeMockAi({
          chat: vi.fn(async () => ({
            status: 'success' as const,
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              estimated: false,
              raw: null,
            },
            body: { object: 'chat.completion', choices: [] },
            durationMs: 5,
          })),
        });
        const origChat = ai.chat.bind(ai);
        ai.chat = async (input) => {
          seenEndpoints.push(input.ctx.endpoint);
          return origChat(input);
        };
        const app = buildTestApp(db, redis, ai);
        const res = await app.request(endpoint.path, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(bodyFor(endpoint.kind, ids.externalModel)),
        });
        expect(res.status).toBe(200);
        // chat 无显式 endpoint（默认）；embeddings 显式 'embeddings'
        expect(seenEndpoints).toEqual([endpoint.kind === 'embeddings' ? 'embeddings' : undefined]);
      } finally {
        await cleanupTestData(db, redis, userId, keyHash, ids);
      }
    });
  }
});
