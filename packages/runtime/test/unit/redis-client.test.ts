/** Redis 客户端工厂：错误监听必挂（不刷 Unhandled）+ 30s 去重 + URL 认证脱敏 + 日志注入面（B2）。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedisClient } from '../../src/redis/redis-client';

const clients: Array<{ disconnect(): void }> = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
  vi.restoreAllMocks();
});

describe('createRedisClient', () => {
  it('错误监听已挂：emit error 不冒 Unhandled，且 30s 窗口内只记一条', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createRedisClient('redis://127.0.0.1:1', { serviceName: 'test-svc' });
    clients.push(client);
    expect(client.listenerCount('error')).toBeGreaterThan(0);

    const boom = new Error('ECONNREFUSED synthetic');
    client.emit('error', boom);
    client.emit('error', boom);
    client.emit('error', boom);
    await new Promise((r) => setTimeout(r, 50));

    const logs = errSpy.mock.calls.map((c) => String(c[0]));
    // 真实连接失败可能抢先占首条——断言「有日志且去重到 ≤1 条」
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.length).toBeLessThanOrEqual(1);
    expect(logs[0]).toContain('test-svc');
    expect(logs[0]).toContain('Redis 不可达');
  });

  it('AggregateError（空 message）展开内层原因，不留空日志', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createRedisClient('redis://127.0.0.1:1', { serviceName: 'agg-svc' });
    clients.push(client);
    client.emit(
      'error',
      new AggregateError([
        new Error('connect ECONNREFUSED ::1:6379'),
        new Error('connect ECONNREFUSED 127.0.0.1:6379'),
      ]),
    );
    await new Promise((r) => setTimeout(r, 20));
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('AggregateError');
    expect(logged).toContain('::1:6379');
    expect(logged).toContain('127.0.0.1:6379');
    expect(logged).not.toMatch(/：——/); // 不允许出现「空原因」日志
  });

  it('日志 URL 脱敏：带密码的连接串抹掉认证信息', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createRedisClient('redis://:secret-pass@127.0.0.1:1', { serviceName: 's' });
    clients.push(client);
    client.emit('error', new Error('x'));
    await new Promise((r) => setTimeout(r, 20));
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('secret-pass');
  });

  it('B2 回归：注入 log 时降级日志走注入出口，不再打 console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines: string[] = [];
    const client = createRedisClient('redis://127.0.0.1:1', {
      serviceName: 'inj-svc',
      log: (msg) => lines.push(msg),
    });
    clients.push(client);
    client.emit('error', new Error('synthetic'));
    await new Promise((r) => setTimeout(r, 20));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('inj-svc');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('sentinel 模式：拓扑解析进实例，url 继续作凭证载体（password/db 提取）', () => {
    const client = createRedisClient('redis://:sen-pass@127.0.0.1:6379/2', {
      serviceName: 'sen-svc',
      sentinels: 'h1:26379,h2:26379',
      sentinelName: 'mymaster',
      sentinelPassword: 'svcpass',
    });
    clients.push(client);
    expect(client.options.sentinels).toEqual([
      { host: 'h1', port: 26379 },
      { host: 'h2', port: 26379 },
    ]);
    expect(client.options.name).toBe('mymaster');
    expect(client.options.sentinelPassword).toBe('svcpass');
    expect(client.options.password).toBe('sen-pass'); // 数据节点凭证来自 url
    expect(client.options.db).toBe(2);
  });
});
