import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createAi } from '../../src/create-ai.js';
import { defaultAiConfig } from '../../src/config.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * A7 回归锁定（R6/G4）：非流式上游读体上限已从默认 256KB 提到 8MB——
 * 合法大输出（>256KB 成功 JSON 含 usage）必须正常成功结算，不再被
 * BodyTooLargeError 误判为 invalid_response（换渠全灭 503 + 预扣冻 uncertain）。
 */

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    // 返回 ~600KB 的成功响应：长 content + 正常 usage
    const big = 'x'.repeat(600 * 1024);
    const body = JSON.stringify({
      id: 'chatcmpl-big',
      object: 'chat.completion',
      model: 'big-real',
      choices: [{ index: 0, message: { role: 'assistant', content: big }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('非流式大响应（>256KB）不再误判（A7）', () => {
  it('600KB 成功体 → success + usage 解析（而非 invalid_response）', async () => {
    const ai = createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps());
    const result = await ai.chat({
      channel: { baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible' },
      request: { model: 'big-real', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 },
      ctx: { requestId: 'a7-big-body', model: 'big-real', providerName: 'test', endpoint: 'chat', deadlineMs: 5000, signal: AbortSignal.timeout(5000) },
    });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(20);
      const body = result.body as { choices?: Array<{ message?: { content?: string } }> };
      expect((body.choices?.[0]?.message?.content?.length ?? 0)).toBeGreaterThan(256 * 1024);
    }
  });
});
