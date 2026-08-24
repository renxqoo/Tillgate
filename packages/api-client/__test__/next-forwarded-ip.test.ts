/**
 * ./next forwarded-ip 行为规格。
 * hops 语义矩阵与 @tillgate/http __test__/network.test.ts 锁步一致(D2 同语义副本约束);
 * outgoingUserIpHeader 为 BFF 透传出口封装(mock next/headers)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { headerStore } = vi.hoisted(() => ({ headerStore: new Headers() }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: vi.fn() })),
  headers: vi.fn(async () => headerStore),
}));

import { outgoingUserIpHeader, trustedClientIp } from '../src/next/forwarded-ip';

function xffHeaders(xff?: string): Headers {
  const h = new Headers();
  if (xff) h.set('x-forwarded-for', xff);
  return h;
}

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe('trustedClientIp(http network.test 同向量)', () => {
  it('hops=0:XFF/X-Real-IP 全部忽略,只用 socket 地址(直连防伪造默认)', () => {
    expect(
      trustedClientIp({
        headers: xffHeaders('1.2.3.4'),
        trustedProxyHops: 0,
        socketAddress: '10.0.0.5',
      }),
    ).toBe('10.0.0.5');
    const h = xffHeaders('1.2.3.4');
    h.set('x-real-ip', '5.6.7.8');
    expect(trustedClientIp({ headers: h, trustedProxyHops: 0, socketAddress: '10.0.0.5' })).toBe(
      '10.0.0.5',
    );
  });

  it('hops=1 + 单条 XFF(无伪造)→ 取该条', () => {
    expect(
      trustedClientIp({
        headers: xffHeaders('203.0.113.9'),
        trustedProxyHops: 1,
        socketAddress: '10.0.0.5',
      }),
    ).toBe('203.0.113.9');
  });

  it('hops=1 + 客户端伪造首段(fake, real)→ 取右数第 1 跳 = real,伪造被丢弃', () => {
    expect(
      trustedClientIp({
        headers: xffHeaders('6.6.6.6, 203.0.113.9'),
        trustedProxyHops: 1,
        socketAddress: '10.0.0.5',
      }),
    ).toBe('203.0.113.9');
  });

  it('hops=1 + 多段伪造(a, b, real)→ 仍取 real', () => {
    expect(
      trustedClientIp({
        headers: xffHeaders('a, b, 203.0.113.9'),
        trustedProxyHops: 1,
        socketAddress: '10.0.0.5',
      }),
    ).toBe('203.0.113.9');
  });

  it('hops=2(双层代理):取右数第 2 跳(第一层代理看到的客户端)', () => {
    expect(
      trustedClientIp({
        headers: xffHeaders('fake, 198.51.100.7, 10.1.0.1'),
        trustedProxyHops: 2,
        socketAddress: null,
      }),
    ).toBe('198.51.100.7');
  });

  it('hops>0 但 XFF 条目不足(代理未追加=配置错位)→ 回退 socket', () => {
    expect(
      trustedClientIp({
        headers: xffHeaders('only-one'),
        trustedProxyHops: 2,
        socketAddress: '10.0.0.5',
      }),
    ).toBe('10.0.0.5');
  });

  it('无 XFF、无 socket(测试环境)→ 进程级唯一兜底(同一进程内稳定)', () => {
    const a = trustedClientIp({ headers: xffHeaders(), trustedProxyHops: 0, socketAddress: null });
    const b = trustedClientIp({ headers: xffHeaders(), trustedProxyHops: 1, socketAddress: null });
    expect(a).toBe(b);
    expect(a.startsWith('unknown-')).toBe(true);
  });

  it('非法 hops 输入防御:小数向下取整,负数归零', () => {
    expect(
      trustedClientIp({ headers: xffHeaders('a, b'), trustedProxyHops: 1.9, socketAddress: null }),
    ).toBe('b');
    expect(
      trustedClientIp({
        headers: xffHeaders('1.2.3.4'),
        trustedProxyHops: -1,
        socketAddress: '10.0.0.5',
      }),
    ).toBe('10.0.0.5');
  });
});

describe('outgoingUserIpHeader:BFF 透传出口头', () => {
  it('TRUSTED_PROXY_HOPS=1 + XFF → 透传右数第 1 跳(env 逐调用读取)', async () => {
    headerStore.delete('x-forwarded-for');
    headerStore.set('x-forwarded-for', '6.6.6.6, 203.0.113.9');
    process.env.TRUSTED_PROXY_HOPS = '1';
    await expect(outgoingUserIpHeader()).resolves.toEqual({ 'x-forwarded-for': '203.0.113.9' });
  });

  it('hops=0(dev 直连):解不出用户 IP → 不带该头(API 回落 socket)', async () => {
    headerStore.delete('x-forwarded-for');
    headerStore.set('x-forwarded-for', '203.0.113.9');
    await expect(outgoingUserIpHeader()).resolves.toEqual({});
  });

  it('非法 env 值(非数字)按 0 处理', async () => {
    headerStore.set('x-forwarded-for', '203.0.113.9');
    process.env.TRUSTED_PROXY_HOPS = 'not-a-number';
    await expect(outgoingUserIpHeader()).resolves.toEqual({});
  });

  it('非请求上下文(SSG 构建等 headers() 抛出)→ 不带该头不炸', async () => {
    const { headers } = await import('next/headers');
    vi.mocked(headers).mockRejectedValueOnce(new Error('outside request'));
    await expect(outgoingUserIpHeader()).resolves.toEqual({});
  });
});
