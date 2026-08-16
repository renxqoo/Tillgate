import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import type { Ai, ChannelDesc } from '../../src/types.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 特征化测试（重构安全网）：钉住 openai-compatible 协议发往上游的线上行为——
 *   URL 路径、认证头、请求体终改（model 重写 / stream_options 注入）、探测请求。
 * 这些行为将从 create-ai.ts 编排层下沉进 ProtocolAdapter（契约扩展），
 * 本文件保证搬移前后逐字节等价。若任一断言变红，说明搬移改变了线上行为。
 */

function makeAi(): Ai {
  return createAi({
    retry: {
      maxAttempts: 1,
      baseDelayMs: 5,
      maxDelayMs: 10,
      jitterRatio: 0,
      deadlineMs: 5000,
      emptyCompletionRetries: 0,
    },
    breaker: { windowMs: 60_000, failureThreshold: 99, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 },
    timeout: { connectMs: 2000, totalMs: 5000 },
    deadCredential: { failureThreshold: 99, windowMs: 3_600_000 },
    allowLocalUrl: true,
  }, memoryDeps());
}

const channel = (baseUrl: string): ChannelDesc => ({
  baseUrl,
  apiKey: 'sk-test',
  protocol: 'openai-compatible',
});

const OK_JSON = JSON.stringify({
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const OK_SSE =
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
  'data: [DONE]\n\n';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** 捕获单条上游请求（method/url/headers/JSON body），并按 kind 回应 */
async function captureUpstream(respond: (req: CapturedRequest, res: import('node:http').ServerResponse) => void): Promise<{
  server: Awaited<ReturnType<typeof startServer>>;
  getRequest: () => CapturedRequest | undefined;
}> {
  let captured: CapturedRequest | undefined;
  const server = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = (JSON.parse(raw) as Record<string, unknown>) ?? {};
      } catch {
        body = {};
      }
      captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      respond(captured, res);
    });
  });
  return { server, getRequest: () => captured };
}

const okJson = (_req: CapturedRequest, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(OK_JSON);
};

const okSse = (_req: CapturedRequest, res: import('node:http').ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(OK_SSE);
};

const baseCtx = { requestId: 'r-wire', model: 'deepseek-chat', providerName: 'deepseek' };

describe('上游线上行为特征化（openai-compatible）', () => {
  it('chat 非流式:POST /v1/chat/completions + Bearer + content-type + idempotency-key + model 重写', async () => {
    const { server, getRequest } = await captureUpstream(okJson);
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
        ctx: baseCtx,
      });
      expect(result.status).toBe('success');
      const req = getRequest();
      expect(req?.method).toBe('POST');
      expect(req?.url).toBe('/v1/chat/completions');
      expect(req?.headers.authorization).toBe('Bearer sk-test');
      expect(req?.headers['content-type']).toBe('application/json');
      expect(req?.headers['idempotency-key']).toBe('r-wire');
      expect(req?.body.model).toBe('deepseek-chat');
    } finally {
      await server.close();
    }
  });

  it('embeddings 端点:POST /v1/embeddings', async () => {
    const { server, getRequest } = await captureUpstream(okJson);
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { model: 'embedding-v1', input: 'hi' },
        ctx: { ...baseCtx, requestId: 'r-embed', endpoint: 'embeddings' },
      });
      expect(result.status).toBe('success');
      const req = getRequest();
      expect(req?.method).toBe('POST');
      expect(req?.url).toBe('/v1/embeddings');
      expect(req?.headers.authorization).toBe('Bearer sk-test');
    } finally {
      await server.close();
    }
  });

  it('chatStream:stream_options 强制注入且保留用户键,model 重写', async () => {
    const { server, getRequest } = await captureUpstream(okSse);
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: {
          model: 'deepseek-v4-pro',
          stream: true,
          stream_options: { custom_flag: true, include_usage: false },
          messages: [{ role: 'user', content: 'hi' }],
        },
        ctx: baseCtx,
      });
      const reader = handle.stream.getReader();
      await reader.read();
      const req = getRequest();
      expect(req?.method).toBe('POST');
      expect(req?.url).toBe('/v1/chat/completions');
      expect(req?.headers.authorization).toBe('Bearer sk-test');
      expect(req?.headers['idempotency-key']).toBe('r-wire');
      expect(req?.body.model).toBe('deepseek-chat');
      expect(req?.body.stream_options).toEqual({
        custom_flag: true,
        include_usage: true,
        continuous_usage_stats: true,
      });
    } finally {
      await server.close();
    }
  });

  it('chatStream:无 stream_options 时注入完整默认', async () => {
    const { server, getRequest } = await captureUpstream(okSse);
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        ctx: baseCtx,
      });
      const reader = handle.stream.getReader();
      await reader.read();
      expect(getRequest()?.body.stream_options).toEqual({
        include_usage: true,
        continuous_usage_stats: true,
      });
    } finally {
      await server.close();
    }
  });

  it('probe:GET /v1/models + Bearer', async () => {
    const { server, getRequest } = await captureUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    try {
      const result = await makeAi().probe(channel(server.baseUrl));
      expect(result.ok).toBe(true);
      const req = getRequest();
      expect(req?.method).toBe('GET');
      expect(req?.url).toBe('/v1/models');
      expect(req?.headers.authorization).toBe('Bearer sk-test');
    } finally {
      await server.close();
    }
  });
});
