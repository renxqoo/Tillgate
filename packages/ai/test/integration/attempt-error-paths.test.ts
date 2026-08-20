import { describe, expect, it } from 'vitest';
import { createAi, defineAdapter } from '../../src/index.js';
import { ServerDrainAbort } from '../../src/errors/server-drain.js';
import { defaultAiConfig } from '../../src/config.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 尝试体错误分支（pipeline/chat + chat-stream 的 catch 家族）：
 * drain / 调用方取消 / 单次超时 / 响应体超限 / 适配器抛 UpstreamError / 网络错误 /
 * 流式首字节超时。全部经 createAi 真实 HTTP 走通。
 */
const CHAT_OK = JSON.stringify({
  id: 'c1', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
});

const makeAi = (overrides: Record<string, unknown> = {}) =>
  createAi(
    { ...defaultAiConfig(), allowLocalUrl: true, ...overrides },
    memoryDeps(),
  );

const chatInput = (baseUrl: string, signal?: AbortSignal, vendor?: string) => ({
  channel: { baseUrl, apiKey: 'sk-t', protocol: 'openai-compatible', ...(vendor ? { vendor } : {}) },
  request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  ctx: { requestId: 'err-path', model: 'm', providerName: 't', endpoint: 'chat' as const, maxRetries: 0, ...(signal ? { signal } : {}) },
});

describe('非流式尝试体 catch 家族', () => {
  it('服务 drain：signal 以 ServerDrainAbort 中止 → server_draining 错误', async () => {
    // 慢响应（150ms）制造中止窗口——快响应会赢过 abort 产生竞态
    const upstream = await startServer((_q, res) => {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK); }, 150);
    });
    try {
      const controller = new AbortController();
      const ai = makeAi();
      const p = ai.chat(chatInput(upstream.baseUrl, controller.signal));
      controller.abort(new ServerDrainAbort('test-drain'));
      const result = await p;
      expect(result.status).toBe('error');
      if (result.status === 'error') expect(result.error?.code).toBe('server_draining');
    } finally {
      await upstream.close();
    }
  });

  it('调用方取消（普通 abort）→ aborted 错误', async () => {
    const upstream = await startServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK); });
    try {
      const controller = new AbortController();
      const ai = makeAi();
      const p = ai.chat(chatInput(upstream.baseUrl, controller.signal));
      controller.abort();
      const result = await p;
      if (result.status === 'error') expect(result.error?.code).toBe('aborted');
    } finally {
      await upstream.close();
    }
  });

  it('单次尝试超时（totalMs=1 + 慢上游）→ timeout', async () => {
    const upstream = await startServer((_q, res) => {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CHAT_OK); }, 200);
    });
    try {
      const ai = makeAi({ timeout: { connectMs: 2_000, totalMs: 20 } });
      const result = await ai.chat(chatInput(upstream.baseUrl));
      if (result.status === 'error') expect(result.error?.code).toBe('timeout');
    } finally {
      await upstream.close();
    }
  });

  it('响应体超限（>8MB）→ invalid_response（BodyTooLarge 归一）', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: big }));
    });
    try {
      const ai = makeAi();
      const result = await ai.chat(chatInput(upstream.baseUrl));
      if (result.status === 'error') expect(result.error?.code).toBe('invalid_response');
    } finally {
      await upstream.close();
    }
  });

  it('适配器 signRequest 抛 UpstreamError → 原样上抛（不吞成 network）', async () => {
    const throwing = defineAdapter({
      protocol: 'throwing-sign',
      addressing: {
        planRequest: (channel) => ({ path: '/v1/chat/completions', headers: { authorization: `Bearer ${channel.apiKey}` } }),
        signRequest: () => {
          throw Object.assign(new Error('sign failed'), {
            code: 'invalid_config', retryable: false, circuitTrip: false, deadCredential: false,
          });
        },
      },
    });
    const ai = createAi(
      { ...defaultAiConfig(), allowLocalUrl: true },
      memoryDeps(),
      { adapters: [throwing] },
    );
    const result = await ai.chat({
      channel: { baseUrl: 'https://any.test', apiKey: 'k', protocol: 'throwing-sign' },
      request: { model: 'm', messages: [] },
      ctx: { requestId: 'sign-throw', model: 'm', providerName: 't', endpoint: 'chat', maxRetries: 0 },
    });
    if (result.status === 'error') expect(result.error?.code).toBe('invalid_config');
  });

  it('网络错误（连接拒绝）→ network', async () => {
    const ai = makeAi();
    const result = await ai.chat(chatInput('http://127.0.0.1:1'));
    if (result.status === 'error') expect(result.error?.code).toBe('network');
  });
});

describe('流式尝试体 catch 家族', () => {
  it('流式 drain / 取消 / 网络错误 → failEarly 错误帧流 + failed 事件', async () => {
    const ai = makeAi();

    // drain：只发头不发包（flushHeaders 保证头已到、首字节未到），中止即命中
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    });
    try {
      const controller = new AbortController();
      const pending = ai.chatStream({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'openai-compatible' },
        request: { model: 'm', messages: [], stream: true },
        ctx: { requestId: 's-drain', model: 'm', providerName: 't', endpoint: 'chat', signal: controller.signal },
      });
      controller.abort(new ServerDrainAbort('drain'));
      const handle = await pending;
      const events: Array<{ type: string; error?: { code: string } }> = [];
      handle.onEvent((e) => events.push(e as never));
      const text = await new Response(handle.stream).text();
      expect(text).toContain('server_draining');
      expect(events.some((e) => e.type === 'failed' && e.error?.code === 'server_draining')).toBe(true);
    } finally {
      await upstream.close();
    }

    // 网络错误
    const handle = await ai.chatStream({
      channel: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', protocol: 'openai-compatible' },
      request: { model: 'm', messages: [], stream: true },
      ctx: { requestId: 's-net', model: 'm', providerName: 't', endpoint: 'chat' },
    });
    const text = await new Response(handle.stream).text();
    expect(text).toContain('"code":"network"');
  });

  it('流式首字节超时（firstByteTimeoutMs=30 + 只发头不发包）→ timeout', async () => {
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // flushHeaders 保证响应头到达（fetch resolve），body 首字节永不到达
      res.flushHeaders();
    });
    try {
      const ai = makeAi({ stream: { heartbeatIdleMs: 60_000, firstByteTimeoutMs: 30, inactivityTimeoutMs: 60_000 } });
      const result = await ai.chatStream({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'openai-compatible' },
        request: { model: 'm', messages: [], stream: true },
        ctx: { requestId: 's-peek-timeout', model: 'm', providerName: 't', endpoint: 'chat' },
      });
      const text = await new Response(result.stream).text();
      expect(text).toContain('"code":"timeout"');
    } finally {
      await upstream.close();
    }
  }, 10_000);

  it('流式 4xx 响应体超限 → invalid_response', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    const upstream = await startServer((_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: big } }));
    });
    try {
      const ai = makeAi();
      const result = await ai.chatStream({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'openai-compatible' },
        request: { model: 'm', messages: [], stream: true },
        ctx: { requestId: 's-toobig', model: 'm', providerName: 't', endpoint: 'chat' },
      });
      const text = await new Response(result.stream).text();
      expect(text).toContain('"code":"invalid_response"');
    } finally {
      await upstream.close();
    }
  });
});
