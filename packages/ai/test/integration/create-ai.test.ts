import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import type { AiConfig } from '../../src/config.js';
import type { AiEvent } from '../../src/events.js';
import type { Ai, ChannelDesc, ChatStreamResult, RequestCtx } from '../../src/types.js';
import { sseFrame, startServer } from './helpers.js';

/**
 * create-ai 集成场景（本地 http server mock 上游）：
 *   chat：成功/空完成/5xx 重试/429 重试后成功/401 不重试/熔断联动/参数抹平/usage 估算
 *   chatStream：正常 SSE 事件/流内错误帧/流开始前失败（错误流 + failed 事件）
 *   probe：成功/失败
 */

function makeAi(overrides?: Partial<AiConfig>): Ai {
  return createAi({
    retry: {
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 10,
      jitterRatio: 0,
      deadlineMs: 5000,
      emptyCompletionRetries: 1,
    },
    breaker: { windowMs: 60_000, failureThreshold: 3, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 },
    timeout: { connectMs: 2000, totalMs: 5000 },
    estimate: { charPerToken: 3.5 },
    deadCredential: { failureThreshold: 3, windowMs: 3_600_000 },
    allowLocalUrl: true, // 集成测试连 127.0.0.1（生产必须 false）
    ...overrides,
  });
}

function channel(baseUrl: string): ChannelDesc {
  return { baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible' };
}

function ctx(requestId: string, extra?: Partial<RequestCtx>): RequestCtx {
  return { requestId, model: 'deepseek-chat', providerName: 'deepseek', ...extra };
}

const OK_JSON = JSON.stringify({
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: '你好，世界' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

async function collectStream(handle: ChatStreamResult): Promise<{ text: string; events: AiEvent[] }> {
  const events: AiEvent[] = [];
  handle.onEvent((e) => events.push(e));
  const reader = handle.stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  return { text: chunks.join(''), events };
}

describe('ai.chat 集成', () => {
  it('成功：200 + usage 归一化', async () => {
    const server = await startServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer sk-test');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OK_JSON);
    });
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
        ctx: ctx('r-success'),
      });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, estimated: false });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await server.close();
    }
  });

  it('空完成：200 空 body → status empty', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end();
    });
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-empty'),
      });
      expect(result.status).toBe('empty');
    } finally {
      await server.close();
    }
  });

  it('5xx：重试 maxAttempts 次后 error（同渠道重试，server 计数=3）', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
    });
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-5xx'),
      });
      expect(calls).toBe(3);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error?.code).toBe('upstream_error');
        expect(result.error?.retryable).toBe(true);
        expect(result.error?.circuitTrip).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it('429：可重试 → 重试后成功', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OK_JSON);
    });
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-429'),
      });
      expect(calls).toBe(2);
      expect(result.status).toBe('success');
    } finally {
      await server.close();
    }
  });

  it('401：死凭据不重试（server 计数=1）', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-401'),
      });
      expect(calls).toBe(1);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error?.code).toBe('invalid_api_key');
        expect(result.error?.deadCredential).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it('死凭据联动：连续 401 达阈值 → dead_credential 拒绝且不再请求上游（5.16）', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    try {
      // 阈值设为 2，便于测试
      const ai = makeAi({ deadCredential: { failureThreshold: 2, windowMs: 3_600_000 } });
      // 前两次 401：返回 invalid_api_key，但凭据计数累积
      await ai.chat({ channel: channel(server.baseUrl), request: { messages: [] }, ctx: ctx('r-dc-1') });
      await ai.chat({ channel: channel(server.baseUrl), request: { messages: [] }, ctx: ctx('r-dc-2') });
      expect(calls).toBe(2);
      // 第三次：凭据已 invalid，被 dead_credential 拒绝，不再请求上游
      const result = await ai.chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-dc-3'),
      });
      expect(calls).toBe(2); // 未再请求上游
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error?.code).toBe('dead_credential');
      }
    } finally {
      await server.close();
    }
  });

  it('熔断联动：连续 5xx 达阈值 → open 后 circuit_open 拒绝且不再请求上游', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    });
    try {
      const ai = makeAi();
      const first = await ai.chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-break-1'),
      });
      expect(first.status).toBe('error');
      expect(calls).toBe(3); // maxAttempts=3，三次 5xx 计数达阈值 3 → open

      const second = await ai.chat({
        channel: channel(server.baseUrl),
        request: { messages: [] },
        ctx: ctx('r-break-2'),
      });
      expect(second.status).toBe('error');
      if (second.status === 'error') {
        expect(second.error?.code).toBe('circuit_open');
      }
      expect(calls).toBe(3); // 熔断后不再发起上游请求
    } finally {
      await server.close();
    }
  });

  it('参数抹平链路：paramRules clamp 生效（上游收到钳制后的值）', async () => {
    let receivedBody: Record<string, unknown> | null = null;
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        receivedBody = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(OK_JSON);
      });
    });
    try {
      await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-chat', temperature: 1.0, messages: [] },
        ctx: ctx('r-clamp', { paramRules: { clamp: { temperature: { max: 0.5 } } } }),
      });
      // TS 不跟踪闭包内赋值，需断言绕过控制流收窄
      const got = receivedBody as Record<string, unknown> | null;
      expect(got?.temperature).toBe(0.5);
    } finally {
      await server.close();
    }
  });

  it('usage 缺失：按请求/响应字符估算（estimated=true）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' } }] }));
    });
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { messages: [{ role: 'user', content: 'hi there' }] },
        ctx: ctx('r-est'),
      });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.usage?.estimated).toBe(true);
        expect(result.usage?.cachedInputTokens).toBe(0);
        expect((result.usage?.outputTokens ?? 0)).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await server.close();
    }
  });
});

describe('ai.chatStream 集成', () => {
  it('正常 SSE：透传 + usage 事件 + success 事件', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: '你' } }] })));
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: '好' } }] })));
      res.write(sseFrame(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } })));
      res.end();
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-chat', stream: true, messages: [] },
        ctx: ctx('rs-ok'),
      });
      const { text, events } = await collectStream(handle);
      expect(text).toContain('你');
      expect(text).toContain('好');
      const usageEv = events.find((e) => e.type === 'usage');
      expect(usageEv?.type).toBe('usage');
      if (usageEv?.type === 'usage') {
        expect(usageEv.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
      }
      const successEv = events.at(-1);
      expect(successEv?.type).toBe('success');
    } finally {
      await server.close();
    }
  });

  it('chatStream 自动注入 stream_options.include_usage（用户未显式设置时）', async () => {
    // 真实驱动：MiniMax/OpenAI 流式需 include_usage:true 才在尾帧发 usage，
    // 不注入则全程 usage:null → gateway 只能靠 bytesRelayed 粗估（漏计费风险）。
    let receivedBody: any = null;
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })));
        res.write(sseFrame(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 } })));
        res.end();
      });
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { model: 'minimax-m3', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        ctx: ctx('rs-stream-options'),
      });
      await collectStream(handle);
      // 注入 include_usage:true（用户未显式设置时）
      expect(receivedBody?.stream_options).toEqual({ include_usage: true });
    } finally {
      await server.close();
    }
  });

  it('chatStream 不覆盖用户显式设置的 stream_options', async () => {
    let receivedBody: any = null;
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })));
        res.end();
      });
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: {
          model: 'deepseek-chat',
          stream: true,
          messages: [],
          stream_options: { include_usage: false }, // 用户显式关闭
        },
        ctx: ctx('rs-stream-options-preserve'),
      });
      await collectStream(handle);
      // 用户显式设置 → 不覆盖
      expect(receivedBody?.stream_options).toEqual({ include_usage: false });
    } finally {
      await server.close();
    }
  });

  it('流内错误帧：透传 + stream_error 事件', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } })));
      res.end();
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-err'),
      });
      const { text, events } = await collectStream(handle);
      expect(text).toContain('slow down');
      const se = events.find((e) => e.type === 'stream_error');
      expect(se?.type).toBe('stream_error');
      if (se?.type === 'stream_error') expect(se.frame.code).toBe('rate_limited');
    } finally {
      await server.close();
    }
  });

  it('流内中断（upstream_disconnected）：success 带 terminated + bytesRelayed（B2/B3）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })));
      setTimeout(() => res.destroy(), 30); // 发了一帧后断流
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-break'),
      });
      const { text, events } = await collectStream(handle);
      expect(text).toContain('hello');
      expect(text).toContain('upstream_disconnected');
      const aborted = events.find((e) => e.type === 'aborted');
      expect(aborted?.type).toBe('aborted');
      if (aborted?.type === 'aborted') expect(aborted.reason).toBe('upstream_disconnected');
      const successEv = events.find((e) => e.type === 'success');
      expect(successEv?.type).toBe('success');
      if (successEv?.type === 'success') {
        // B2：中断语义显式带出，gateway 据此标 stream_aborted
        expect(successEv.terminated).toBe('upstream_disconnected');
        // B3：已透字节量 > 0，gateway 可据此估算 tokens（5.11）
        expect((successEv.bytesRelayed ?? 0)).toBeGreaterThan(0);
      }
    } finally {
      await server.close();
    }
  });

  it('流式空完成重试：200 立即 EOF → 首帧探测判空 → 重试（D3）', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(); // 立即 EOF，无任何 data 帧 → 首帧探测判空
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-empty'),
      });
      const { events } = await collectStream(handle);
      // emptyCompletionRetries=1 + maxAttempts=3 → 重试后仍空，发 empty_completion
      expect(calls).toBeGreaterThanOrEqual(2); // 至少重试 1 次
      const empty = events.find((e) => e.type === 'empty_completion');
      expect(empty?.type).toBe('empty_completion');
    } finally {
      await server.close();
    }
  });

  it('事件序列：attempt_start + param_adjustment + success（B4）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OK_JSON);
    });
    try {
      const ai = makeAi();
      const globalEvents: AiEvent[] = [];
      const off = ai.onEvent((e) => globalEvents.push(e));
      await ai.chat({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-chat', temperature: 1.0, messages: [] },
        ctx: ctx('r-events', { paramRules: { clamp: { temperature: { max: 0.5 } } } }),
      });
      off();
      // attempt_start 至少 1 次
      const attempts = globalEvents.filter((e) => e.type === 'attempt_start');
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      if (attempts[0]?.type === 'attempt_start') {
        expect(attempts[0].channelKey).toContain('openai-compatible://');
      }
      // param_adjustment：temperature 被 clamp
      const adj = globalEvents.find(
        (e) => e.type === 'param_adjustment' && e.param === 'temperature',
      );
      expect(adj?.type).toBe('param_adjustment');
      if (adj?.type === 'param_adjustment') {
        expect(adj.action).toBe('clamp');
        expect(adj.from).toBe(1.0);
        expect(adj.to).toBe(0.5);
      }
      // success 最后发，带 channelKey
      const successEv = globalEvents.at(-1);
      expect(successEv?.type).toBe('success');
      if (successEv?.type === 'success') {
        expect(successEv.channelKey).toContain('openai-compatible://');
      }
    } finally {
      await server.close();
    }
  });

  it('流式熔断联动：连续断流达阈值 → 后续 chatStream 返回 circuit_open 错误流（B6）', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
      setTimeout(() => res.destroy(), 10); // 每次都断流
    });
    try {
      const ai = makeAi();
      // 第一次：发一帧后断流（upstream_disconnected，计熔断）
      const h1 = await ai.chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-brk-1'),
      });
      await collectStream(h1);
      // 断流计入熔断，但单次不足以达阈值 3；多调几次累积
      const h2 = await ai.chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-brk-2'),
      });
      await collectStream(h2);
      const h3 = await ai.chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-brk-3'),
      });
      await collectStream(h3);
      // 第 4 次：熔断应已 open，返回 circuit_open 错误流（不再请求上游）
      const beforeCalls = calls;
      const h4 = await ai.chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-brk-4'),
      });
      const { text, events } = await collectStream(h4);
      expect(calls).toBe(beforeCalls); // 熔断后不再请求上游
      expect(text).toContain('circuit_open');
      const failed = events.find((e) => e.type === 'failed');
      expect(failed?.type).toBe('failed');
      if (failed?.type === 'failed') expect(failed.error.code).toBe('circuit_open');
    } finally {
      await server.close();
    }
  });

  it('流开始前失败（401）：错误流（OpenAI 兼容错误帧）+ failed 事件，不重试', async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: { stream: true, messages: [] },
        ctx: ctx('rs-401'),
      });
      expect(calls).toBe(1); // 死凭据不重试
      const { text, events } = await collectStream(handle);
      expect(text).toContain('invalid_api_key');
      const failed = events.find((e) => e.type === 'failed');
      expect(failed?.type).toBe('failed');
      if (failed?.type === 'failed') {
        expect(failed.error.code).toBe('invalid_api_key');
        expect(failed.error.deadCredential).toBe(true);
      }
    } finally {
      await server.close();
    }
  });
});

describe('ai.probe 集成', () => {
  it('200 → ok', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      const result = await makeAi().probe(channel(server.baseUrl));
      expect(result.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('401 → not ok + 死凭据错误', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    try {
      const result = await makeAi().probe(channel(server.baseUrl));
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_api_key');
    } finally {
      await server.close();
    }
  });
});

describe('配置校验（fail fast：空 key/model/baseUrl 直接报错，不发请求）', () => {
  it('chat：空 apiKey → invalid_config', async () => {
    const ai = makeAi();
    const result = await ai.chat({
      channel: { baseUrl: 'https://api.example.com', apiKey: '', protocol: 'openai-compatible' },
      request: { model: 'x', messages: [] },
      ctx: ctx('r-empty-key'),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error?.code).toBe('invalid_config');
      expect(result.error?.message).toContain('apiKey');
    }
  });

  it('chat：空 baseUrl → invalid_config', async () => {
    const ai = makeAi();
    const result = await ai.chat({
      channel: { baseUrl: '', apiKey: 'sk-x', protocol: 'openai-compatible' },
      request: { model: 'x', messages: [] },
      ctx: ctx('r-empty-url'),
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error?.code).toBe('invalid_config');
  });

  it('chat：空 model → invalid_config', async () => {
    const ai = makeAi();
    const result = await ai.chat({
      channel: { baseUrl: 'https://api.example.com', apiKey: 'sk-x', protocol: 'openai-compatible' },
      request: { messages: [] },
      ctx: { requestId: 'r-empty-model', model: '', providerName: 'x' },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error?.message).toContain('model');
  });

  it('chatStream：空 apiKey → 错误流含 invalid_config', async () => {
    const ai = makeAi();
    const handle = await ai.chatStream({
      channel: { baseUrl: 'https://api.example.com', apiKey: '', protocol: 'openai-compatible' },
      request: { stream: true, messages: [] },
      ctx: ctx('rs-empty-key'),
    });
    const events: AiEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const reader = handle.stream.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    expect(text).toContain('invalid_config');
    const failed = events.find((e) => e.type === 'failed');
    expect(failed?.type).toBe('failed');
    if (failed?.type === 'failed') expect(failed.error.code).toBe('invalid_config');
  });

  it('probe：空 apiKey → invalid_config（不发请求）', async () => {
    const ai = makeAi();
    const result = await ai.probe({ baseUrl: 'https://api.example.com', apiKey: '', protocol: 'openai-compatible' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_config');
    expect(result.durationMs).toBe(0); // 立即返回，未发起请求
  });
});
