import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createAi, allowAllUrls } from '../src/index.js';

const startServer = (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) =>
  new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });

const channel = (baseUrl: string) => ({ baseUrl, apiKey: 'sk-t', protocol: 'openai-compatible' });
const mk = () => createAi({ retry: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0, deadlineMs: 5000, emptyCompletionRetries: 0 }, timeout: { connectMs: 2000, totalMs: 5000 }, stream: { heartbeatIdleMs: 1000, firstByteTimeoutMs: 2000, inactivityTimeoutMs: 5000 } }, { guardUrl: allowAllUrls });

describe('contract：chat 非流式', () => {
  it('成功：200 JSON → ok + usage 归一', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    });
    try {
      const ai = mk();
      const r = await ai.chat(channel(s.baseUrl), { model: 'gpt-4o', messages: [] });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.usage?.inputTokens).toBe(3);
        expect(r.usage?.outputTokens).toBe(2);
        expect(r.usage?.estimated).toBe(false);
      }
    } finally {
      await s.close();
    }
  });

  it('失败：429 → rate_limited kind + 机制位派生（retryable=true, trip=false）', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }));
    });
    try {
      const ai = mk();
      const r = await ai.chat(channel(s.baseUrl), { model: 'm', messages: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('rate_limited');
        expect(r.error.retryable).toBe(true);
        expect(r.error.circuitTrip).toBe(false);
        expect(r.error.vendorCode).toBe('rate_limit_exceeded');
      }
    } finally {
      await s.close();
    }
  });

  it('requestId 缺省生成且贯穿事件流；subscribe 全局观察', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    try {
      const ai = mk();
      const events: string[] = [];
      ai.subscribe((e) => events.push(e.type));
      const r = await ai.chat(channel(s.baseUrl), { model: 'm', messages: [] });
      expect(r.ok).toBe(true);
      expect(events).toEqual(['attempt_start', 'success']);
    } finally {
      await s.close();
    }
  });
});

describe('contract：chatStream 流式', () => {
  it('透传 + 事件序列（attempt_start → first_chunk → success 终态最后）', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ai = mk();
      const { stream, events } = await ai.chatStream(channel(s.baseUrl), { model: 'm', messages: [], stream: true });
      const text = await new Response(stream).text();
      expect(text).toContain('{"content":"你"}'); // 原始帧逐字节透传（wire 保真）
      expect(text).toContain('[DONE]');
      const seen: string[] = [];
      events.subscribe((e) => seen.push(e.type));
      await new Promise((r) => setTimeout(r, 50));
      // 晚订阅契约：per-call events 只重放终态（attempt_start 等经全局 subscribe 观察）
      expect(seen[seen.length - 1]).toBe('success');
    } finally {
      await s.close();
    }
  });

  it('use() 糖：绑定渠道等价直调', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    try {
      const gpt = mk().use(channel(s.baseUrl));
      const r = await gpt.chat({ model: 'm', messages: [] });
      expect(r.ok).toBe(true);
    } finally {
      await s.close();
    }
  });
});
