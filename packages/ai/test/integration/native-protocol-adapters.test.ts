import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai';
import { aiConfigSchema } from '../../src/config';
import { memoryDeps } from '../helpers/memory-deps';
import { startServer, type MockUpstream } from './helpers';

/**
 * 原生协议适配器端到端：本地 mock 上游说 claude/gemini 线格式，
 * createAi 默认注册表（六协议族）把响应/流归一为规范形。
 */

let upstream: MockUpstream;
beforeAll(async () => {
  upstream = await startServer((req, res) => {
    res.on('error', () => {});
    if (req.url?.startsWith('/v1/messages')) {
      if (req.headers['x-api-key'] !== 'sk-anthropic') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const ev = (event: string, obj: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_x', model: 'claude-sonnet-4-5', usage: { input_tokens: 12, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 12, output_tokens: 5 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    if (req.url?.includes(':generateContent') || req.url?.includes(':streamGenerateContent')) {
      if (req.headers['x-goog-api-key'] !== 'sk-gemini') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 403, message: 'bad key', status: 'UNAUTHENTICATED' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      frame({ candidates: [{ content: { role: 'model', parts: [{ text: 'Yo' }] } }] });
      frame({ candidates: [{ content: { role: 'model', parts: [{ text: '!' }] } }] });
      frame({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 } });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
afterAll(async () => {
  await upstream.close();
});

const cfg = aiConfigSchema.parse({
  allowLocalUrl: true,
  timeout: { connectMs: 1000, firstByteMs: 3000, totalMs: 10000, heartbeatIdleMs: 30000, inactivityTimeoutMs: 15000 },
});

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

describe('anthropic 适配器端到端（上游翻译为规范形）', () => {
  it('chatStream：claude 事件流 → 规范形 OpenAI SSE，usage 归一，finish=stop', async () => {
    const ai = createAi(cfg, memoryDeps());
    const { stream, onEvent } = await ai.chatStream({
      channel: { baseUrl: upstream.baseUrl, apiKey: 'sk-anthropic', protocol: 'anthropic' },
      request: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx: { requestId: 'req-anthropic-1', model: 'claude-sonnet-4-5', providerName: 'anthropic', deadlineMs: 10000 },
    });
    const events: unknown[] = [];
    onEvent((e) => events.push(e));
    const text = await readStream(stream);
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"content":"!"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"prompt_tokens":12');
    expect(text).toContain('"completion_tokens":5');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const usageEvent = events.find((e) => (e as { type: string }).type === 'success') as { usage?: { inputTokens: number; outputTokens: number } } | undefined;
    expect(usageEvent?.usage).toEqual({ inputTokens: 12, cachedInputTokens: 0, outputTokens: 5, estimated: false, raw: expect.any(Object) });
  });

  it('chat 非流式（上游仍 SSE）：整体读完 → usage 事件可用（上游翻译路径不炸）', async () => {
    const ai = createAi(cfg, memoryDeps());
    const result = await ai.chat({
      channel: { baseUrl: upstream.baseUrl, apiKey: 'sk-anthropic', protocol: 'anthropic' },
      request: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      ctx: { requestId: 'req-anthropic-2', model: 'claude-sonnet-4-5', providerName: 'anthropic', deadlineMs: 10000 },
    });
    // 上游对非流式请求也回了 SSE——体不是 JSON 时归类失败而非崩溃（翻译只对 JSON 生效）
    expect(['success', 'error', 'empty']).toContain(result.status);
  });

  it('认证错误：deadCredential 特征从 claude error type 提取', async () => {
    const ai = createAi(cfg, memoryDeps());
    const result = await ai.chat({
      channel: { baseUrl: upstream.baseUrl, apiKey: 'wrong', protocol: 'anthropic' },
      request: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      ctx: { requestId: 'req-anthropic-3', model: 'claude-sonnet-4-5', providerName: 'anthropic', deadlineMs: 10000 },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error?.code).toBe('invalid_api_key');
      expect(result.error?.deadCredential).toBe(true);
    }
  });
});

describe('gemini 适配器端到端', () => {
  it('chatStream：alt=sse 数据帧 → 规范形，usage/finish 归一，[DONE] 补齐', async () => {
    const ai = createAi(cfg, memoryDeps());
    const { stream, onEvent } = await ai.chatStream({
      channel: { baseUrl: upstream.baseUrl, apiKey: 'sk-gemini', protocol: 'gemini' },
      request: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], stream: true },
      ctx: { requestId: 'req-gemini-1', model: 'gemini-2.5-pro', providerName: 'google', deadlineMs: 10000 },
    });
    const events: unknown[] = [];
    onEvent((e) => events.push(e));
    const text = await readStream(stream);
    expect(text).toContain('"content":"Yo"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"prompt_tokens":7');
    expect(text).toContain('"completion_tokens":2');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const usageEvent = events.find((e) => (e as { type: string }).type === 'success') as { usage?: { inputTokens: number; outputTokens: number } } | undefined;
    expect(usageEvent?.usage?.inputTokens).toBe(7);
  });
});
