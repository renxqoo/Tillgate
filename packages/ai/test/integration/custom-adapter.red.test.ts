import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import type { Ai, ChannelDesc, RequestCtx } from '../../src/types.js';
import type { ProtocolAdapter } from '../../src/adapters/protocol-adapter.js';
import { createUpstreamError } from '../../src/errors/classify.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 红灯测试：「注册即扩展」——上游协议适配器可注入 createAi，
 * 编排层不再写死 URL 路径 / 认证头 / 请求体终改 / 探测请求。
 *
 * 当前实现（改造前）createAi 不接受第三个 options 参数、协议注册表
 * 写死 openai-compatible：本文件全部用例失败（红）。
 * 契约扩展后转绿：新协议 = 实现 ProtocolAdapter + 注册一行。
 */

function makeAi(adapters: ProtocolAdapter[]): Ai {
  return createAi(
    {
      retry: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0, deadlineMs: 5000, emptyCompletionRetries: 0 },
      breaker: { windowMs: 60_000, failureThreshold: 99, cooldownMs: 300_000, halfOpenProbe: true },
      stream: { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 },
      timeout: { connectMs: 2000, totalMs: 5000 },
      deadCredential: { failureThreshold: 99, windowMs: 3_600_000 },
      allowLocalUrl: true,
    },
    memoryDeps(),
    { adapters },
  );
}

/** 假协议 adapter：一切线上行为可辨识（路径含 model、自定义头、体终改、探测路径） */
const testEchoAdapter: ProtocolAdapter = {
  protocol: 'test-echo',
  planRequest: (channel, input) => ({
    path: input.endpoint === 'embeddings' ? '/echo/embeddings' : `/echo/${input.model}/generate`,
    headers: {
      'x-api-key': channel.apiKey,
      'x-echo-request-id': input.requestId,
      'content-type': 'application/json',
    },
  }),
  finalizeRequestBody: (body, input) => ({
    ...body,
    model: input.model,
    echo_finalized: input.stream ? 'stream' : 'once',
  }),
  normalizeRequest: (req) => ({ body: req, adjustments: [] }),
  extractUsage: () => ({
    inputTokens: 7,
    cachedInputTokens: 0,
    outputTokens: 3,
    estimated: false,
    raw: { source: 'test-echo' },
  }),
  mapError: (status, body) =>
    createUpstreamError({
      status,
      code: 'test_echo_error',
      message: `echo upstream rejected: ${JSON.stringify(body)}`,
      retryable: false,
      circuitTrip: false,
    }),
  probeRequests: (channel) => [{ path: '/echo/health', headers: { 'x-api-key': channel.apiKey } }],
};

const OK_JSON = JSON.stringify({ result: 'echoed' });
const OK_SSE = 'data: {"delta":"hi"}\n\ndata: [DONE]\n\n';

const echoChannel = (baseUrl: string): ChannelDesc => ({
  baseUrl,
  apiKey: 'echo-key',
  protocol: 'test-echo',
});

const echoCtx: RequestCtx = { requestId: 'r-echo', model: 'echo-model-x', providerName: 'echo' };

describe('自定义协议 adapter 注入（注册即扩展）', () => {
  it('chat:命中 adapter 的自定义路径与认证头,请求体经 finalizeRequestBody 终改', async () => {
    let seen: { method?: string; url?: string; headers: Record<string, unknown>; body: Record<string, unknown> } | undefined;
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: JSON.parse(raw) as Record<string, unknown>,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(OK_JSON);
      });
    });
    try {
      const result = await makeAi([testEchoAdapter]).chat({
        channel: echoChannel(server.baseUrl),
        request: { model: 'external-name', messages: [{ role: 'user', content: 'hi' }] },
        ctx: echoCtx,
      });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        // usage 来自 adapter.extractUsage,而非 openai 格式解析
        expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
      }
      expect(seen?.method).toBe('POST');
      expect(seen?.url).toBe('/echo/echo-model-x/generate');
      expect(seen?.headers['x-api-key']).toBe('echo-key');
      expect(seen?.headers['x-echo-request-id']).toBe('r-echo');
      expect(seen?.headers.authorization).toBeUndefined();
      expect(seen?.body.model).toBe('echo-model-x');
      expect(seen?.body.echo_finalized).toBe('once');
    } finally {
      await server.close();
    }
  });

  it('chatStream:adapter 路径生效,流式终改 stream 标记', async () => {
    let seen: { url?: string; body: Record<string, unknown> } | undefined;
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        seen = { url: req.url, body: JSON.parse(raw) as Record<string, unknown> };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(OK_SSE);
      });
    });
    try {
      const handle = await makeAi([testEchoAdapter]).chatStream({
        channel: echoChannel(server.baseUrl),
        request: { model: 'external-name', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        ctx: echoCtx,
      });
      const reader = handle.stream.getReader();
      await reader.read();
      expect(seen?.url).toBe('/echo/echo-model-x/generate');
      expect(seen?.body.echo_finalized).toBe('stream');
    } finally {
      await server.close();
    }
  });

  it('embeddings 端点走 adapter 的 embeddings 路径', async () => {
    let seenUrl: string | undefined;
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        seenUrl = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(OK_JSON);
      });
    });
    try {
      const result = await makeAi([testEchoAdapter]).chat({
        channel: echoChannel(server.baseUrl),
        request: { model: 'external-name', input: 'hi' },
        ctx: { ...echoCtx, endpoint: 'embeddings' },
      });
      expect(result.status).toBe('success');
      expect(seenUrl).toBe('/echo/embeddings');
    } finally {
      await server.close();
    }
  });

  it('probe:使用 adapter 的自定义探测路径与认证头', async () => {
    let seen: { method?: string; url?: string; headers: Record<string, unknown> } | undefined;
    const server = await startServer((req, res) => {
      seen = { method: req.method, url: req.url, headers: { ...req.headers } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    try {
      const result = await makeAi([testEchoAdapter]).probe(echoChannel(server.baseUrl));
      expect(result.ok).toBe(true);
      expect(seen?.method).toBe('GET');
      expect(seen?.url).toBe('/echo/health');
      expect(seen?.headers['x-api-key']).toBe('echo-key');
    } finally {
      await server.close();
    }
  });

  it('未注册协议的错误信息列出注册表实际支持的协议键', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OK_JSON);
    });
    try {
      // 注册表只有 test-echo,openai-compatible 反而未注册
      const result = await makeAi([testEchoAdapter]).chat({
        channel: { baseUrl: server.baseUrl, apiKey: 'sk', protocol: 'openai-compatible' },
        request: { model: 'm', messages: [] },
        ctx: { requestId: 'r-un', model: 'm', providerName: 'p' },
      });
      expect(result.status).toBe('error');
      if (result.status === 'error' && result.error) {
        expect(result.error.code).toBe('invalid_config');
        expect(result.error.message).toContain('test-echo');
        expect(result.error.message).not.toContain('only');
      }
    } finally {
      await server.close();
    }
  });

  it('注册表拒绝重复协议键:启动即抛(结构上杜绝双真相)', () => {
    expect(() => makeAi([testEchoAdapter, testEchoAdapter])).toThrow(/duplicate/i);
  });
});
