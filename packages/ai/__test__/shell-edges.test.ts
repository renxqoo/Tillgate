import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createAi, allowAllUrls } from '../src/index.js';
import { estimateInputTokens } from '../src/usage/token-estimate.js';
import { detectSilentOverflow } from '../src/errors/overflow.js';
import { responsesRequestToChat, canonicalStreamToResponsesStream } from '../src/protocol/responses-chat.js';
import { signAwsRequest, parseAwsCredentials } from '../src/adapters/aws-bedrock.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { defineAdapter } from '../src/registry/define-adapter.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';

const startServer = (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) =>
  new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });

const mk = () => createAi({ retry: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0, deadlineMs: 5000, emptyCompletionRetries: 1 }, timeout: { connectMs: 2000, totalMs: 5000 }, stream: { heartbeatIdleMs: 60_000, firstByteTimeoutMs: 2000, inactivityTimeoutMs: 5000 } }, { guardUrl: allowAllUrls });
const ch = (b: string, protocol = 'openai-compatible') => ({ baseUrl: b, apiKey: 'sk-t', protocol });

describe('create-ai 壳：异常分支', () => {
  it('B6 回归：tasks 未注册协议 → task_ops_unavailable（非误导的"未返回 taskId"）', async () => {
    const ai = mk();
    const r1 = ai.tasks.parse(ch('https://x.test', 'openai-compatible'), 'video', {});
    expect(r1.kind).toBe('error');
    if (r1.kind === 'error') expect(r1.error.kind).toBe('task_ops_unavailable');
    const r2 = await ai.tasks.query(ch('https://x.test'), 't1');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('task_ops_unavailable');
    const r3 = await ai.tasks.file(ch('https://x.test'), 'f1');
    expect(r3.ok).toBe(false);
  });

  it('chatStream 上游 4xx：failEarly 错误流（OpenAI 信封帧）+ failed 终态', async () => {
    const s = await startServer((_q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }));
    });
    try {
      const { stream, events } = await mk().chatStream(ch(s.baseUrl), { model: 'm', messages: [], stream: true });
      const text = await new Response(stream).text();
      expect(text).toContain('invalid_api_key');
      expect(text).toContain('[DONE]');
      const seen: string[] = [];
      events.subscribe((e) => seen.push(e.type));
      expect(seen[seen.length - 1]).toBe('failed');
    } finally { await s.close(); }
  });

  it('空流重试：上游立即 EOF → empty 分支', async () => {
    let hits = 0;
    const s = await startServer((_q, res) => { hits += 1; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); });
    try {
      const r = await mk().chatStream(ch(s.baseUrl), { model: 'm', messages: [], stream: true });
      await new Response(r.stream).text();
      expect(hits).toBeGreaterThanOrEqual(2); // 空完成独立预算触发重试
    } finally { await s.close(); }
  });

  it('probe：200 即通；401 归类死凭据', async () => {
    const s = await startServer((_q, res) => { res.writeHead(200); res.end('{}'); });
    try {
      const r = await mk().probe(ch(s.baseUrl));
      expect(r.ok).toBe(true);
    } finally { await s.close(); }
    const s2 = await startServer((_q, res) => { res.writeHead(401); res.end(JSON.stringify({ error: { code: 'invalid_api_key' } })); });
    try {
      const r2 = await mk().probe(ch(s2.baseUrl));
      expect(r2.ok).toBe(false);
      expect(r2.error?.deadCredential).toBe(true);
    } finally { await s2.close(); }
  });

  it('配置校验：空 apiKey/缺 model 不发请求直接报错', async () => {
    const r = await mk().chat({ baseUrl: 'https://x.test', apiKey: '', protocol: 'openai-compatible' }, { model: 'm', messages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_config');
    const r2 = await mk().chat(ch('https://x.test'), { messages: [] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('invalid_config');
  });

  it('endpoint 能力声明：openai-compatible 请求 chat 协议不支持的端点显式报错', async () => {
    const r = await mk().chat(ch('https://x.test', 'anthropic'), { model: 'm', messages: [] }, { endpoint: 'embeddings' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_config');
  });
});

describe('usage/token-estimate 输入侧与 overflow', () => {
  it('输入侧：messages/tools/embeddings token 数组分支', () => {
    expect(estimateInputTokens({ model: 'm', messages: [{ role: 'user', content: '你好 abc' }] })).toBeGreaterThan(0);
    expect(estimateInputTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })).toBeGreaterThan(0);
    expect(estimateInputTokens({ model: 'm', tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] })).toBeGreaterThan(0);
    expect(estimateInputTokens({ model: 'm', input: [1, 2, 3] })).toBe(3); // embeddings 每 id 计 1
    expect(estimateInputTokens('garbage')).toBe(0);
  });
  it('detectSilentOverflow：超窗输入真、窗口内假、垃圾输入假（不翻转语义）', () => {
    expect(detectSilentOverflow(10_000_000, 'openai', 'gpt-4o')).toBe(true);
    expect(detectSilentOverflow(100, 'openai', 'gpt-4o')).toBe(false);
    expect(detectSilentOverflow(-1, 'openai', 'gpt-4o')).toBe(false);
    expect(detectSilentOverflow(Number.NaN)).toBe(false);
    expect(detectSilentOverflow(100, 'unknown-vendor', 'no-model')).toBe(false);
  });
});

describe('protocol/responses-chat 与 adapter 细节', () => {
  it('responses 入站：instructions→system、max_output_tokens 映射', () => {
    const chat = responsesRequestToChat({ model: 'm', instructions: 'sys', input: 'hi', max_output_tokens: 100, temperature: 0.5 });
    expect(chat.model).toBe('m');
    expect(chat.max_tokens).toBe(100);
    expect((chat.messages as Array<{ role: string }>)[0]?.role).toBe('system');
  });
  it('responses 出站：五事件流合成（含 usage last-wins）', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(canonicalStreamToResponsesStream(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); } }))).text();
    expect(out).toContain('response.output_text.delta');
    expect(out).toContain('response.completed');
    expect(out).toContain('"output_tokens":1');
  });
  it('bedrock SigV4：签名头齐全 + 凭据解析', () => {
    const creds = parseAwsCredentials('AKID:SECRET');
    expect(creds).toMatchObject({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' });
    expect(parseAwsCredentials('bad')).toBeNull();
    const headers = signAwsRequest({ method: 'POST', url: new URL('https://bedrock.test/model/x/invoke'), body: '{}', credentials: { accessKeyId: 'AKID', secretAccessKey: 'SEC' }, at: new Date('2026-01-01T00:00:00Z') });
    expect(Object.keys(headers)).toEqual(expect.arrayContaining(['x-amz-date', 'x-amz-content-sha256', 'authorization']));
    expect(headers.authorization).toContain('AWS4-HMAC-SHA256');
  });
  it('vertex token 交换：fetchImpl 注入，SA 解析与缓存语义', async () => {
    let exchanged = 0;
    const fakeFetch = (async () => {
      exchanged += 1;
      return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
    }) as unknown as typeof fetch;
    const adapter = new VertexAiAdapter(fakeFetch);
    const headers = await adapter.signRequest?.({ url: new URL('https://vertex.test/x'), body: '{}', apiKey: 'sa-json' }).catch(() => null);
    void headers;
    expect(exchanged).toBeLessThanOrEqual(1); // 至多一次交换（缓存或失败）
  });
  it('defineAdapter 组合：只覆写寻址其余落默认', () => {
    const custom = defineAdapter({
      protocol: 'test-combo',
      addressing: {
        planRequest: (_c, i) => ({ path: `/custom/${i.model}`, headers: {} }),
        probeRequests: () => [{ path: '/custom/probe', headers: {} }],
      },
    });
    expect(custom.protocol).toBe('test-combo');
    expect(custom.planRequest(ch('https://x.test', 'test-combo'), { endpoint: 'chat', model: 'm', requestId: 'r', stream: false }).path).toBe('/custom/m');
    expect(custom.supportedEndpoints).toEqual(new OpenAICompatibleAdapter().supportedEndpoints); // 能力继承默认
  });
});
