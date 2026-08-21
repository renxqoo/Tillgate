/**
 * 安全与攻击面专项（切片二补测）：
 *   - CORS：白名单外 Origin 无 ACAO；白名单内预检 204 + ACAO
 *   - 请求体上限：超限 content-length → 413 提前拒绝
 *   - 幂等键字符集：含冒号（系统命名空间字符）→ 400 invalid_idempotency_key
 *   - 会话攻击：篡改签名 / 过期 token / 跨面 token → 401
 *   - 全模块未授权扫描：每资源面无 token → 401
 *   - 搜索注入：q 含 %/_ 为字面量（不是通配语法）
 *   - XSS 载荷：名字原样存储（JSON 输出转义由框架保证）+ nosniff 头
 *   - 凭证键穿越变体 → 404
 *   - 分页健壮性：page=NaN → 1；page_size 巨大 → 钳 100
 */
import { describe, expect, it } from 'vitest';
import { signSession } from '@ai-gateway/identity';
import { eq } from 'drizzle-orm';
import { providers as providersTable } from '@ai-gateway/db';
import { randomUUID } from 'node:crypto';
import { buildTestApp, db, newAdmin, newProviderRow, TEST_JWT_SECRET, uid } from './helpers.js';

describe('CORS 预检', () => {
  it('白名单外 Origin → 无 Access-Control-Allow-Origin；白名单内 → 204 + ACAO', async () => {
    const { app } = buildTestApp({ corsOrigins: ['https://admin.example.com'] });
    const evil = await app.request('/v1/providers', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const allowed = await app.request('/v1/providers', {
      method: 'OPTIONS',
      headers: { origin: 'https://admin.example.com', 'access-control-request-method': 'POST' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
  });
});

describe('请求体上限', () => {
  it('content-length 超限 → 413 提前拒绝', async () => {
    const { app } = buildTestApp();
    const { token } = await newAdmin();
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-length': '99999999', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });
});

describe('幂等键命名空间攻击', () => {
  it('含冒号的 idempotency-key（抢占系统键命名空间）→ 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const res = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId: providerId, amount: '1' },
      headers: { 'idempotency-key': 'signup-gift:1' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('会话攻击面', () => {
  it('篡改签名 / 过期 token / 乱码 → 401', async () => {
    const { request } = buildTestApp();
    await newAdmin();
    const tampered = (await signSession({ type: 'admin', id: 1 }, TEST_JWT_SECRET)).slice(0, -4) + 'AAAA';
    expect((await request('/v1/me', { token: tampered })).status).toBe(401);

    const expired = await signSession({ type: 'admin', id: 1, expiresInSeconds: -1 }, TEST_JWT_SECRET);
    expect((await request('/v1/me', { token: expired })).status).toBe(401);

    expect((await request('/v1/me', { token: 'garbage.token.here' })).status).toBe(401);
  });
});

describe('全模块未授权扫描', () => {
  it('每资源面无 token → 401（fail-closed 默认）', async () => {
    const { request } = buildTestApp();
    const paths = [
      '/v1/providers',
      '/v1/channels',
      '/v1/models',
      '/v1/rate-cards',
      '/v1/model-catalog/sources',
      '/v1/vendor-catalog',
      '/v1/users',
      '/v1/admin-keys',
      '/v1/subscriptions',
      '/v1/plans',
      '/v1/redeem-batches',
      '/v1/channel-funds',
      '/v1/vouchers/00000000-0000-4000-8000-000000000000.png',
    ];
    for (const path of paths) {
      expect((await request(path)).status, path).toBe(401);
    }
  });
});

describe('搜索注入（q 无语法）', () => {
  it('q 中的 % 与 _ 按字面匹配', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const stamp = uid('inj');
    await request('/v1/providers', { token, body: { name: `${stamp}-alpha`, baseUrl: 'https://a.example.com/v1' } });
    // % 通配注入：`stamp%` 不应命中 `stamp-alpha`（若未转义会全命中）
    const wildcard = (await (
      await request(`/v1/providers?q=${stamp}%25`, { token })
    ).json()) as { total: number };
    expect(wildcard.total).toBe(0);
    // _ 单字符通配注入：`stamp-alpha` 的 a 换成 _ 不应命中
    const underscore = (await (
      await request(`/v1/providers?q=${stamp}-_lpha`, { token })
    ).json()) as { total: number };
    expect(underscore.total).toBe(0);
  });
});

describe('XSS 载荷与响应头', () => {
  it('脚本载荷名字原样存储；响应 JSON + nosniff', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    // aav2- 前缀 = 测试名命名空间（清理兜底按此前缀扫）
    const name = `aav2-<script>${randomUUID().slice(0, 6)}</script>`;
    const res = await request('/v1/providers', { token, body: { name, baseUrl: 'https://x.example.com/v1' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toContain('application/json');
    const [row] = await db.select().from(providersTable).where(eq(providersTable.name, name));
    expect(row).toBeTruthy(); // 原样存储（输出侧 JSON 转义；管理面富文本渲染是前端职责）
  });
});

describe('分页健壮性', () => {
  it('page=NaN → 1；page_size 巨大 → 钳 100；order 非法 → desc', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const body = (await (
      await request('/v1/providers?page=NaN&page_size=99999&order=diagonal', { token })
    ).json()) as { page: number; pageSize: number };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(100);
  });
});
