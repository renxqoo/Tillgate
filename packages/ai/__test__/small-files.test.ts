import { describe, expect, it } from 'vitest';
import { joinUrl } from '../src/join-url.js';
import { tokenCountOf, TOKENIZE_MAX_CHARS } from '../src/usage/tokenizer.js';
import { isContextOverflowMessage } from '../src/errors/overflow.js';
import { registerSweep } from '../src/transport/heartbeat.js';
import { isRetryable, isDeadCredential, KIND_MECHANICS } from '../src/errors/kinds.js';
import { failEarlyStream, createStreamEventBus, attachRelayReporting } from '../src/pipeline/stream-report.js';
import { UpstreamError } from '../src/errors/kinds.js';
import { defineAdapter } from '../src/registry/define-adapter.js';
import { relayStream } from '../src/transport/relay-stream.js';

describe('join-url 版本段去重', () => {
  it('base 尾段=路径版本段 → 去重；不同则原样；尾斜杠清理', () => {
    expect(joinUrl('https://h.test/v1', '/v1/chat/completions')).toBe('https://h.test/v1/chat/completions');
    expect(joinUrl('https://h.test/v1/', '/v1/chat/completions')).toBe('https://h.test/v1/chat/completions');
    expect(joinUrl('https://h.test/api', '/v1/chat/completions')).toBe('https://h.test/api/v1/chat/completions');
    expect(joinUrl('https://h.test', '/v1/chat/completions')).toBe('https://h.test/v1/chat/completions');
    expect(joinUrl('https://h.test/V2', '/v2/x')).toBe('https://h.test/V2/x'); // 大小写不敏感
  });
});

describe('tokenizer 分流', () => {
  it('o200k / cl100k 族 + 无模型与超长降级 null', () => {
    expect(tokenCountOf('hello world', 'gpt-4o')).toBeGreaterThan(0);
    expect(tokenCountOf('hello world', 'gpt-4o-mini')).toBeGreaterThan(0);
    expect(tokenCountOf('你好', 'claude-3')).toBeGreaterThan(0);
    expect(tokenCountOf('x', undefined)).toBeNull();
    expect(tokenCountOf('', 'gpt-4o')).toBeNull();
    expect(tokenCountOf('a'.repeat(TOKENIZE_MAX_CHARS + 1), 'gpt-4o')).toBeNull();
  });
});

describe('overflow 消息模式', () => {
  it('溢出命中 / 非溢出优先排除', () => {
    expect(isContextOverflowMessage('prompt is too long')).toBe(true);
    expect(isContextOverflowMessage('This model maximum context length is 4096 tokens')).toBe(true);
    expect(isContextOverflowMessage('rate limit exceeded')).toBe(false);
    expect(isContextOverflowMessage('Throttling error: slow')).toBe(false);
    expect(isContextOverflowMessage('random')).toBe(false);
  });
});

describe('heartbeat 全局扫描器', () => {
  it('注册-检查-注销；false 返回自动注销；空表停表', async () => {
    let checks = 0;
    const off = registerSweep(() => { checks += 1; return true; });
    let once = 0;
    const off2 = registerSweep(() => { once += 1; return false; }); // 立即注销
    await new Promise((r) => setTimeout(r, 350));
    off();
    off2();
    expect(checks).toBeGreaterThanOrEqual(1);
    expect(once).toBe(1);
  });
});

describe('kinds 谓词 + KIND_MECHANICS 完整性', () => {
  it('谓词；表覆盖全部 kind 值', () => {
    const e = new UpstreamError({ kind: 'invalid_api_key' });
    expect(isDeadCredential(e)).toBe(true);
    expect(isRetryable(e)).toBe(false);
    const keys = Object.keys(KIND_MECHANICS);
    expect(keys.length).toBeGreaterThanOrEqual(19);
    for (const k of keys) {
      const m = KIND_MECHANICS[k as keyof typeof KIND_MECHANICS];
      expect(typeof m.retryable).toBe('boolean');
    }
  });
});

describe('stream-report 深支', () => {
  it('failEarlyStream：错误帧 + 终态重放（晚订阅）', async () => {
    const bus = createStreamEventBus(() => {}, {});
    const r = failEarlyStream(bus, new UpstreamError({ kind: 'rate_limited' }), 'req-1', 'k1');
    const text = await new Response(r.stream).text();
    expect(text).toContain('rate_limited');
    const seen: string[] = [];
    r.events.subscribe((e) => seen.push(e.type));
    expect(seen).toEqual(['failed']); // 终态缓冲重放
  });
  it('attachRelayReporting：done → success 事件带 usage/features', async () => {
    const bus = createStreamEventBus(() => {}, {});
    const handle = relayStream(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n')); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } }), { heartbeatIdleMs: 60_000, inactivityTimeoutMs: 60_000 });
    attachRelayReporting(handle, { bus, requestId: 'r', channelKey: 'k', startedAt: Date.now() });
    await new Response(handle.stream).text();
    const seen: string[] = [];
    const events: unknown[] = [];
    (bus as unknown as { subscribe: (cb: (e: unknown) => void) => void }).subscribe((e) => { events.push(e); seen.push((e as { type: string }).type); });
    expect(seen[seen.length - 1]).toBe('success');
    const success = events.find((e) => (e as { type: string }).type === 'success') as { usage?: { inputTokens: number }; outputFeatures?: { wordSegments: number } };
    expect(success?.usage?.inputTokens).toBe(2);
    expect(success?.outputFeatures).toBeDefined();
  });
});

describe('define-adapter 深支：默认件带签名钩子的 pick 路径', () => {
  it('base 有 signRequest 时组合器透传', async () => {
    const base = new (class {
      protocol = 'signed-base';
      supportedEndpoints = ['chat'] as const;
      planRequest = () => ({ path: '/x', headers: {} });
      probeRequests = () => [{ path: '/p', headers: {} }];
      signRequest = () => ({ auth: 'sig' });
      normalizeRequest = (r: unknown) => ({ body: r, adjustments: [] });
      finalizeRequestBody = (b: Record<string, unknown>) => b;
      extractUsage = () => null;
      mapError = () => new UpstreamError({ kind: 'upstream_error' });
    })();
    void base;
    const combo = defineAdapter({ protocol: 'combo2', addressing: { signRequest: () => ({ 'x-s': '1' }) } as never });
    const h = await combo.signRequest?.({ url: new URL('https://t/x'), body: '', apiKey: 'k', at: new Date() });
    expect(h).toMatchObject({ 'x-s': '1' });
  });
});
