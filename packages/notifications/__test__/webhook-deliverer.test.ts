/**
 * webhook http 适配器:守卫拨号传输注入面(SSRF/签名/POST 分支)。
 * 传输用可编程替身(拨号层守卫语义归 node-transport 自测);SSRF 守卫用替身
 * (真守卫行为归 ai 包自测)。
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createWebhookDeliverer } from '../src/adapters/webhook/http-deliverer';
import type { GuardedHttpPost } from '../src/adapters/webhook/node-transport';
import type { UrlGuard } from '../src/ports/url-guard';
import { defined } from './defined';

interface TransportCall {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

function stubTransport(
  handler: (
    call: TransportCall,
  ) => { ok: boolean; status: number } | Promise<{ ok: boolean; status: number }>,
) {
  const calls: TransportCall[] = [];
  const transport: GuardedHttpPost = async (input) => {
    const call = {
      url: input.url,
      headers: { ...input.headers },
      body: input.body,
      timeoutMs: input.timeoutMs,
    };
    calls.push(call);
    return await handler(call);
  };
  return { calls, transport };
}

const permissive: UrlGuard = {
  async assert(url) {
    return new URL(url);
  },
  assertAddress: () => {},
};

/** 恒失败传输（网络异常/超时收敛形态——deliverer 端口契约:布尔不抛） */
const failingTransport: GuardedHttpPost = async () => ({ ok: false, status: 0 });

function delivererOf(
  over: Partial<Parameters<typeof createWebhookDeliverer>[0]> & { transport?: GuardedHttpPost },
) {
  return createWebhookDeliverer({
    guard: permissive,
    timeoutMs: 1_000,
    allowLocal: false,
    logger: { warn: () => {} },
    ...over,
  });
}

describe('createWebhookDeliverer', () => {
  it('POST 签名头口径:体/签名/头集合与 DESIGN §2.4 一致(自洽验签)', async () => {
    const { calls, transport } = stubTransport(() => ({ ok: true, status: 200 }));
    const warnings: string[] = [];
    const deliverer = delivererOf({
      transport,
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
    const { headers, body } = call;
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
    expect(call.url.toString()).toBe('https://hooks.example.test/h');
    expect(call.timeoutMs).toBe(1_000);
    expect(warnings).toHaveLength(0);
  });

  it('SSRF 守卫拦截:warn + false,不发请求', async () => {
    const { calls, transport } = stubTransport(() => ({ ok: true, status: 200 }));
    const warnings: Array<{ url?: string; error?: string }> = [];
    const blocking: UrlGuard = {
      async assert() {
        throw new Error('private network blocked');
      },
      assertAddress: () => {},
    };
    const deliverer = createWebhookDeliverer({
      guard: blocking,
      timeoutMs: 1_000,
      allowLocal: false,
      logger: { warn: (obj) => warnings.push(obj as { url?: string }) },
      transport,
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
      assertAddress: () => {},
    };
    const { transport } = stubTransport(() => ({ ok: true, status: 200 }));
    const deliverer = createWebhookDeliverer({
      guard,
      timeoutMs: 1_000,
      allowLocal: true,
      logger: { warn: () => {} },
      transport,
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
    const { transport } = stubTransport(() => ({ ok: false, status: 503 }));
    const warnings: Array<{ status?: number }> = [];
    const deliverer = delivererOf({
      transport,
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

  it('传输失败(网络异常/超时收敛):false 不抛(端口契约)', async () => {
    const deliverer = delivererOf({ transport: failingTransport });
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
    const { calls, transport } = stubTransport(() => ({ ok: true, status: 200 }));
    const deliverer = delivererOf({ transport });
    await expect(
      deliverer.deliver({ url: '', secret: 's', event: 'e', payload: {}, deliveryId: '1:1' }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
