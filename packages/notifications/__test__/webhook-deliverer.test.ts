/**
 * webhook http 适配器:fetch 直击(v1 deliver() 的 SSRF/签名/POST 分支移植)。
 * fetch 全局打桩;SSRF 守卫用可编程替身(真守卫行为归 ai 包自测)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createWebhookDeliverer } from '../src/adapters/webhook/http-deliverer';
import type { UrlGuard } from '../src/ports/url-guard';
import { defined } from './defined';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  handler: (
    call: FetchCall,
  ) => { status: number; body?: string } | Promise<{ status: number; body?: string }>,
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const res = await handler(call);
    return new Response(res.body ?? 'ok', { status: res.status });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

const permissive: UrlGuard = {
  async assert(url) {
    return new URL(url);
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('createWebhookDeliverer', () => {
  it('POST 签名头口径:体/签名/头集合与 DESIGN §2.4 一致(自洽验签)', async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    const warnings: string[] = [];
    const deliverer = createWebhookDeliverer({
      guard: permissive,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: (obj, msg) => warnings.push(`${msg}:${JSON.stringify(obj)}`) },
    });
    const ok = await deliverer.deliver({
      url: 'https://hooks.example.test/h',
      secret: 'whsec-test',
      event: 'billing_dead',
      payload: { requestId: 'r1' },
      deliveryId: '9:11',
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = defined(calls[0], 'calls[0]');
    const headers = call.init.headers as Record<string, string>;
    const body = call.init.body as string;
    const timestamp = headers['x-notify-timestamp'];
    // 体 = {event, timestamp, payload}(timestamp 与头一致)
    expect(JSON.parse(body)).toEqual({
      event: 'billing_dead',
      timestamp: Number(timestamp),
      payload: { requestId: 'r1' },
    });
    // 验签口径与接收方一致:HMAC-SHA256(secret, `${ts}.${body}`)
    const expected = createHmac('sha256', 'whsec-test')
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(headers['x-notify-signature']).toBe(expected);
    expect(headers['x-notify-delivery']).toBe('9:11');
    expect(headers['x-notify-event']).toBe('billing_dead');
    expect(headers['content-type']).toBe('application/json');
    expect(call.init.method).toBe('POST');
    expect(warnings).toHaveLength(0);
  });

  it('SSRF 守卫拦截:warn + false,不发请求', async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    const warnings: Array<{ url?: string; error?: string }> = [];
    const blocking: UrlGuard = {
      async assert() {
        throw new Error('private network blocked');
      },
    };
    const deliverer = createWebhookDeliverer({
      guard: blocking,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: (obj) => warnings.push(obj as { url?: string }) },
    });
    const ok = await deliverer.deliver({
      url: 'http://127.0.0.1/hook',
      secret: 's',
      event: 'e',
      payload: {},
      deliveryId: '1:1',
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(warnings[0]?.url).toBe('http://127.0.0.1/hook');
  });

  it('守卫收到 allowLocal 结果值(逃生门透传)', async () => {
    const seen: Array<{ url: string; allowLocal: boolean }> = [];
    const guard: UrlGuard = {
      async assert(url, opts) {
        seen.push({ url, allowLocal: opts.allowLocal });
        return new URL(url);
      },
    };
    stubFetch(() => ({ status: 200 }));
    const deliverer = createWebhookDeliverer({
      guard,
      timeoutMs: 1_000,
      allowLocal: true,
      logger: { warn: () => {} },
    });
    await deliverer.deliver({
      url: 'http://10.0.0.1/h',
      secret: 's',
      event: 'e',
      payload: {},
      deliveryId: '1:1',
    });
    expect(seen[0]).toEqual({ url: 'http://10.0.0.1/h', allowLocal: true });
  });

  it('非 2xx 响应:warn + false(可重试)', async () => {
    stubFetch(() => ({ status: 503, body: 'down' }));
    const warnings: Array<{ status?: number }> = [];
    const deliverer = createWebhookDeliverer({
      guard: permissive,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: (obj) => warnings.push(obj as { status?: number }) },
    });
    const ok = await deliverer.deliver({
      url: 'https://x.test/h',
      secret: 's',
      event: 'e',
      payload: {},
      deliveryId: '1:1',
    });
    expect(ok).toBe(false);
    expect(warnings[0]?.status).toBe(503);
  });

  it('网络异常/超时:收敛为 false 不抛(端口契约)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );
    const deliverer = createWebhookDeliverer({
      guard: permissive,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: () => {} },
    });
    await expect(
      deliverer.deliver({
        url: 'https://x.test/h',
        secret: 's',
        event: 'e',
        payload: {},
        deliveryId: '1:1',
      }),
    ).resolves.toBe(false);
  });

  it('空 url:立即 false,不触守卫不发请求', async () => {
    const { calls } = stubFetch(() => ({ status: 200 }));
    const deliverer = createWebhookDeliverer({
      guard: permissive,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: () => {} },
    });
    await expect(
      deliverer.deliver({ url: '', secret: 's', event: 'e', payload: {}, deliveryId: '1:1' }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
