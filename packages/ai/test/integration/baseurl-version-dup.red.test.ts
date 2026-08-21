import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 回归（new-api #3133 同类）：baseUrl 携带版本段时路径拼接不得重复。
 *
 * joinUrl（join-url.ts）在 baseUrl 尾段是版本段且与适配器路径首段相同时去重；
 * admin 端对 baseUrl 无版本段规范化/校验——管理员按业界惯例填
 * `https://host/v1`（复制自 OpenAI 官方文档）时，若不去重，实际请求会变成
 * `/v1/v1/chat/completions` → 404，且报错与配置根源无关、极难排查。
 */

function makeAi() {
  return createAi({
    retry: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0, deadlineMs: 5000, emptyCompletionRetries: 0 },
    breaker: { windowMs: 60_000, failureThreshold: 100, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 },
    timeout: { connectMs: 2000, totalMs: 5000 },
    allowLocalUrl: true,
  }, memoryDeps());
}

describe('baseUrl 版本段拼接（#3133 同类红测）', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const seenPaths: string[] = [];
  beforeAll(async () => {
    server = await startServer((req, res) => {
      seenPaths.push(req.url ?? '');
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: `no route: ${req.url}` } }));
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it("baseUrl 以 /v1 结尾 → 请求必须落在单个 /v1 路径（不出现 /v1/v1）", async () => {
    const ai = makeAi();
    const result = await ai.chat({
      // 业界惯例：baseUrl 带版本段（复制自 OpenAI 文档的形态）
      channel: { baseUrl: `${server.baseUrl}/v1`, apiKey: 'sk-test', protocol: 'openai-compatible' },
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ctx: { requestId: 'v1-dup-1', model: 'm', providerName: 'test', endpoint: 'chat' },
    });
    expect(result.status).toBe('success');
    // 请求不得打到 /v1/v1/...（去重或规范化后应命中 /v1/chat/completions）
    expect(seenPaths.some((p) => p.includes('/v1/v1'))).toBe(false);
  });
});
