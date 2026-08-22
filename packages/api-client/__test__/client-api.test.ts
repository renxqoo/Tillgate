/**
 * client-api(用户面)facade 行为规格:getMe 布局守卫吞错返 null(v1 行为等价)、
 * facade 委托 core、B1 回归(token 只来自本面注入)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createClientApiClient } from '../src/client-api';

const meBody = JSON.stringify({ id: 1, subject: 'user-1', accounts: [] });

function fetchReturning(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe('getMe 布局守卫(v1 getMe 行为等价)', () => {
  it('成功返回 MeInfo', async () => {
    const client = createClientApiClient({
      baseUrl: 'http://client-api',
      fetch: fetchReturning(200, meBody),
    });
    const me = await client.getMe();
    expect(me?.id).toBe(1);
    expect(me?.subject).toBe('user-1');
  });

  it.each([
    ['401 未登录', fetchReturning(401, JSON.stringify({ error: { message: 'no session' } }))],
    ['500 服务端错误', fetchReturning(500, 'oops')],
    [
      '网络异常',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    ],
  ])('%s → null', async (_name, fetchImpl) => {
    const client = createClientApiClient({ baseUrl: 'http://client-api', fetch: fetchImpl });
    await expect(client.getMe()).resolves.toBeNull();
  });
});

describe('facade 委托 core transport', () => {
  it('request/post 等动词可用,baseUrl 拼接正确', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const client = createClientApiClient({ baseUrl: 'http://client-api', fetch: fetchImpl });
    await client.post('/v1/keys', { name: 'k' });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe('http://client-api/v1/keys');
  });
});

describe('B1 回归:token 只来自本面注入的 getToken(v1 按基地址比较挑选 token 源已废除)', () => {
  it('用户面 client 即使与管理面 base 相同,也只携带自己注入的 token', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      calls.push({ headers: (init as { headers: Record<string, string> }).headers });
      return new Response(meBody, { status: 200 });
    }) as unknown as typeof fetch;
    const user = createClientApiClient({
      baseUrl: 'http://same-host', // v1 缺陷触发条件:两面 base 相同
      fetch: fetchImpl,
      getToken: () => 'user-jwt',
    });
    await user.getMe();
    expect(calls[0]?.headers.authorization).toBe('Bearer user-jwt');
  });
});
