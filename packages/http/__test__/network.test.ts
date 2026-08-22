import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  clientIpFromContext,
  socketAddressFromContext,
  trustedClientIp,
} from '../src/network/trusted-client-ip';

/**
 * XFF 信任模型（TRUSTED_PROXY_HOPS）——v1 trusted-client-ip.test 全部迁移：
 * 「取 XFF 首段」可被客户端任意伪造（换 XFF 即绕过登录限流/authfail 计数），
 * 因此 hops=0 完全忽略代理头；hops=N 取右数第 N 跳（信任的第一层代理看到的客户端）。
 */

function headers(xff?: string): Headers {
  const h = new Headers();
  if (xff) h.set('x-forwarded-for', xff);
  return h;
}

describe('trustedClientIp', () => {
  it('hops=0：XFF/X-Real-IP 全部忽略，只用 socket 地址（直连防伪造默认）', () => {
    expect(trustedClientIp({ headers: headers('1.2.3.4'), trustedProxyHops: 0, socketAddress: '10.0.0.5' })).toBe('10.0.0.5');
    const h = headers('1.2.3.4');
    h.set('x-real-ip', '5.6.7.8');
    expect(trustedClientIp({ headers: h, trustedProxyHops: 0, socketAddress: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('hops=1 + 单条 XFF（无伪造）→ 取该条', () => {
    expect(trustedClientIp({ headers: headers('203.0.113.9'), trustedProxyHops: 1, socketAddress: '10.0.0.5' })).toBe('203.0.113.9');
  });

  it('hops=1 + 客户端伪造首段（fake, real）→ 取右数第 1 跳 = real，伪造被丢弃', () => {
    expect(trustedClientIp({ headers: headers('6.6.6.6, 203.0.113.9'), trustedProxyHops: 1, socketAddress: '10.0.0.5' })).toBe('203.0.113.9');
  });

  it('hops=1 + 多段伪造（a, b, real）→ 仍取 real', () => {
    expect(trustedClientIp({ headers: headers('a, b, 203.0.113.9'), trustedProxyHops: 1, socketAddress: '10.0.0.5' })).toBe('203.0.113.9');
  });

  it('hops=2（双层代理）：取右数第 2 跳（第一层代理看到的客户端）', () => {
    // 链路：client(fake 可选) → proxy1 → proxy2 → 我们。proxy2 追加它看到的对端（proxy1 出口），
    // proxy1 之前追加真实 client。右数第 2 跳 = proxy1 记录的真实客户端。
    expect(trustedClientIp({ headers: headers('fake, 198.51.100.7, 10.1.0.1'), trustedProxyHops: 2, socketAddress: null })).toBe('198.51.100.7');
  });

  it('hops>0 但 XFF 条目不足（代理未追加=配置错位）→ 回退 socket', () => {
    expect(trustedClientIp({ headers: headers('only-one'), trustedProxyHops: 2, socketAddress: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('无 XFF、无 socket（测试环境）→ 进程级唯一兜底（同一进程内稳定）', () => {
    const a = trustedClientIp({ headers: headers(), trustedProxyHops: 0, socketAddress: null });
    const b = trustedClientIp({ headers: headers(), trustedProxyHops: 1, socketAddress: null });
    expect(a).toBe(b);
    expect(a.startsWith('unknown-')).toBe(true);
  });
});

describe('Hono 上下文封装', () => {
  it('app.request 测试形态无连接信息：socketAddressFromContext → null；XFF 命中时 clientIpFromContext 取 XFF', async () => {
    const app = new Hono();
    app.get('/ip', (c) => {
      expect(socketAddressFromContext(c)).toBeNull();
      return c.json({ ip: clientIpFromContext(c, { trustedProxyHops: 1 }) });
    });
    const res = await app.request('/ip', { headers: { 'x-forwarded-for': 'fake, 203.0.113.9' } });
    expect(((await res.json()) as { ip: string }).ip).toBe('203.0.113.9');
  });
});
