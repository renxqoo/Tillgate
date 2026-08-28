/**
 * ./next clients(Next BFF 装配工厂)行为规格:env 基地址解析(dev 兜底只在装配层)、
 * 惰性 memo、端到端头注入(mock next/headers + fake fetch)。
 * 基地址 memo 为模块级状态,各用例 resetModules 后动态导入隔离。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieStore, headerStore } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn() },
  headerStore: new Headers(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => headerStore),
}));

beforeEach(() => {
  delete process.env.CLIENT_API_BASE;
  delete process.env.ADMIN_API_BASE;
  delete process.env.TRUSTED_PROXY_HOPS;
  cookieStore.get.mockReset();
  headerStore.delete('x-forwarded-for');
  headerStore.delete('accept-language');
});

describe('基地址解析(B2 回归:root 工厂 baseUrl 必填,env 读取与 dev 兜底只在 ./next 装配层)', () => {
  it('env 显式值优先', async () => {
    process.env.CLIENT_API_BASE = 'http://env-client:9000';
    vi.resetModules();
    const mod = await import('../src/next/clients');
    expect(mod.getClientApiBase()).toBe('http://env-client:9000');
  });

  it('env 缺失回落本地 dev 端口(8081/8082,生产由 compose 显式注入)', async () => {
    vi.resetModules();
    const mod = await import('../src/next/clients');
    expect(mod.getClientApiBase()).toBe('http://localhost:8081');
    expect(mod.getAdminApiBase()).toBe('http://localhost:8082');
  });

  it('惰性 memo:首次解析后 env 变化不影响(Next 构建期加载模块不要求配置)', async () => {
    process.env.ADMIN_API_BASE = 'http://first';
    vi.resetModules();
    const mod = await import('../src/next/clients');
    expect(mod.getAdminApiBase()).toBe('http://first');
    process.env.ADMIN_API_BASE = 'http://second';
    expect(mod.getAdminApiBase()).toBe('http://first');
  });
});

describe('装配工厂端到端(会话/语言/转发 IP 全链注入)', () => {
  it('用户面:env base + ag_session token + cookie 语言 + hops=1 转发 IP', async () => {
    cookieStore.get.mockImplementation((name: string) => {
      if (name === 'ag_session') return { value: 'user-jwt' };
      if (name === 'NEXT_LOCALE') return { value: 'zh' };
      return;
    });
    headerStore.set('x-forwarded-for', '6.6.6.6, 203.0.113.9');
    process.env.TRUSTED_PROXY_HOPS = '1';
    process.env.CLIENT_API_BASE = 'http://client-api-env';
    vi.resetModules();
    const mod = await import('../src/next/clients');

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = mod.createNextClientApiClient({ fetch: fetchImpl });
    await client.getMe();

    const [call] = vi.mocked(fetchImpl).mock.calls;
    expect(call?.[0]).toBe('http://client-api-env/v1/me');
    if (!call) throw new Error('fetch not called');
    const { headers } = call[1] as { headers: Record<string, string> };
    expect(headers.authorization).toBe('Bearer user-jwt');
    expect(headers['accept-language']).toBe('zh');
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(headers['content-type']).toBe('application/json');
  });

  it('管理面:ag_admin_session token(B1:与用户面 token 源物理隔离)+ baseUrl 覆盖 env', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === 'ag_admin_session' ? { value: 'admin-jwt' } : undefined,
    );
    process.env.ADMIN_API_BASE = 'http://env-ignored';
    vi.resetModules();
    const mod = await import('../src/next/clients');

    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const admin = mod.createNextAdminApiClient({ baseUrl: 'http://override', fetch: fetchImpl });
    await admin.getAdminMe();

    const [call] = vi.mocked(fetchImpl).mock.calls;
    expect(call?.[0]).toBe('http://override/v1/me');
    if (!call) throw new Error('fetch not called');
    const { headers } = call[1] as { headers: Record<string, string> };
    expect(headers.authorization).toBe('Bearer admin-jwt');
    expect(headers['accept-language']).toBe('en'); // 无 cookie 无头 → 默认英文
    expect(headers['x-forwarded-for']).toBeUndefined(); // hops 未配置 → 不带
  });
});
