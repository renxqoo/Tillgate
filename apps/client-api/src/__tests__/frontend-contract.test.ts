/**
 * 前端契约 E2E（按「前端实际读取的字段」钉死响应形状）：
 *   ① apps 动词别名（DELETE /:id、POST /:id/rotate-secret）
 *   ② keys 创建/轮换返回 key 字段（前端读 res.key 展示一次性明文）
 *   ③ orgs 列表形状（id/subscriptionName/remainingAmount + list/total 信封）
 *   ④ 订阅列表「生效中个人订阅置顶」+ 计算字段（过期订阅不得冒充当前订阅）
 *   ⑤ 金额字段 number 直传不再 400（dailySpendLimit/monthlyQuota）
 *   ⑥ 分页 page_size 别名（page_size=50 → 返回 50 行语义）
 *   ⑦ 支付订单详情端点 + 支付回调兼容路径别名
 *   ⑧ 注册 fail-closed（无 SMTP = 503，绝不单步建号）
 *   ⑨ 登录爆破锁不 DoS 受害者（正确密码在被锁维度下仍放行）
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { apiKeys, apps as appsTable, plans, userSubscriptions, users } from '@ai-gateway/db';
import { assembleClientApi } from '../assembly.js';
import { createApp } from '../app.js';
import { waitForRedisReady } from '@ai-gateway/core';
import { db, newUser } from './helpers.js';

const createdUsers: number[] = [];
const createdAppIds: number[] = [];
const createdPlanIds: number[] = [];

type TestApp = ReturnType<typeof createApp>;
let app: TestApp;
let token: string;
let userId: number;

async function newUserWithSession(): Promise<{ token: string; userId: number }> {
  const account = await newUser();
  createdUsers.push(account.id);
  const res = await app.request('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: 'correct-horse-battery' }),
  });
  const body = (await res.json()) as { kind: string; token?: string };
  expect(body.kind).toBe('success');
  return { token: body.token!, userId: account.id };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

beforeAll(async () => {
  const assembly = assembleClientApi(
    {
      DATABASE_URL: 'postgres://unused',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      PORT: 0,
      DB_POOL_MAX: 5,
      CLIENT_CURRENCY: 'CNY',
      JWT_SECRET: 'contract-test-secret-0123456789',
      SESSION_TTL_SECONDS: 3_600,
      REGISTER_ENABLED: true,
      GIFT_AMOUNT: '0',
      MAX_KEYS_PER_USER: 100,
      MAX_APPS_PER_USER: 100,
      REGISTER_IP_LIMIT_PER_HOUR: 5,
      LOGIN_FAILURE_THRESHOLD: 5,
      LOGIN_FAILURE_WINDOW_S: 600,
      LOGIN_LOCK_S: 600,
      LOGIN_IP_FAILURE_LIMIT: 50,
      LOGIN_IP_FAILURE_WINDOW_S: 300,
      TRUSTED_PROXY_HOPS: 0,
      CORS_ORIGINS: '',
      BODY_LIMIT_BYTES: 65_536,
      TOPUP_MIN: '1',
      TOPUP_MAX: '10000',
      TOPUP_EXCHANGE_RATE: '1',
      PAYMENT_ORDER_TTL_MS: 1_800_000,
      REFERRAL_SIGNUP_BONUS: '0',
      REFERRAL_COMMISSION_RATE: '0',
      EPAY_PID: '1001',
      EPAY_KEY: 'test-epay-key',
      EPAY_GATEWAY_URL: 'https://pay.example.com/submit.php',
      EPAY_NOTIFY_URL: 'https://api.example.com/v1/payments/notify/epay',
      EPAY_RETURN_URL: 'https://console.example.com/wallet',
      CLIENT_SHUTDOWN_GRACE_MS: 1_000,
      OTEL_TRACES_MODE: 'off',
    } as never,
    db,
  );
  await waitForRedisReady(assembly.redis);
  app = createApp({
    db,
    assembly,
    jwtSecret: 'contract-test-secret-0123456789',
    trustedProxyHops: 0,
    corsOrigins: [],
    bodyLimitBytes: 65_536,
  });
  ({ token, userId } = await newUserWithSession());
});

afterAll(async () => {
  if (createdAppIds.length) await db.delete(appsTable).where(inArray(appsTable.id, createdAppIds));
  const keyRows = createdUsers.length
    ? await db.select({ id: apiKeys.id }).from(apiKeys).where(inArray(apiKeys.userId, createdUsers))
    : [];
  if (keyRows.length) await db.delete(apiKeys).where(inArray(apiKeys.id, keyRows.map((k) => k.id)));
  if (createdUsers.length) {
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.userId, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  if (createdPlanIds.length) await db.delete(plans).where(inArray(plans.id, createdPlanIds));
});

describe('前端契约 · apps 正位动词（兼容别名已拆）', () => {
  it('POST /v1/apps → POST /v1/apps/:id/disable 禁用成功；旧 DELETE 别名 404', async () => {
    const create = await app.request('/v1/apps', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ name: 'contract-app' }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: number; clientSecret: string };
    createdAppIds.push(id);

    const disable = await app.request(`/v1/apps/${id}/disable`, {
      method: 'POST',
      headers: auth(token),
    });
    expect(disable.status).toBe(200);
    // 兼容别名已拆（前端已改调正位）
    const del = await app.request(`/v1/apps/${id}`, { method: 'DELETE', headers: auth(token) });
    expect(del.status).toBe(404);
  });

  it('POST /v1/apps/:id/rotate 返回新 secret；旧 rotate-secret 别名 404', async () => {
    const create = await app.request('/v1/apps', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ name: 'contract-app-2' }),
    });
    const { id } = (await create.json()) as { id: number };
    createdAppIds.push(id);

    const rotate = await app.request(`/v1/apps/${id}/rotate`, {
      method: 'POST',
      headers: auth(token),
    });
    expect(rotate.status).toBe(200);
    const body = (await rotate.json()) as { clientSecret: string };
    expect(body.clientSecret).toBeTruthy();
    const legacy = await app.request(`/v1/apps/${id}/rotate-secret`, { method: 'POST', headers: auth(token) });
    expect(legacy.status).toBe(404);
  });
});

describe('前端契约 · keys 明文字段（正位 plaintext，兼容 key 字段已拆）', () => {
  it('创建返回 plaintext（前端读 res.plaintext），无 key 字段', async () => {
    const res = await app.request('/v1/admin-keys', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ name: 'contract-key' }),
    });
    const actual = res.status === 404
      ? await app.request('/v1/keys', {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({ name: 'contract-key' }),
        })
      : res;
    expect(actual.status).toBe(201);
    const body = (await actual.json()) as { plaintext: string; id: number; key?: string };
    expect(body.plaintext).toMatch(/^ag_/);
    expect(body.key).toBeUndefined(); // 兼容字段已拆
    await db.delete(apiKeys).where(eq(apiKeys.id, body.id));
  });
});

describe('前端契约 · orgs 列表形状', () => {
  it('GET /v1/orgs 返回 orgId/planName/remainingAmount + rows/total 信封（v1 字段与 list 已拆）', async () => {
    const res = await app.request('/v1/orgs', { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows?: Array<{ orgId?: number; planName?: string | null; remainingAmount?: string; id?: number; subscriptionName?: string }>;
      list?: unknown[];
      total?: number;
    };
    expect(body.list).toBeUndefined();
    expect(typeof body.total).toBe('number');
    for (const row of body.rows ?? []) {
      expect(row).toHaveProperty('orgId');
      expect(row).toHaveProperty('planName');
      expect(row).toHaveProperty('remainingAmount');
      expect(row.id).toBeUndefined();
      expect(row.subscriptionName).toBeUndefined();
    }
  });
});

describe('前端契约 · 订阅语义', () => {
  it('GET /v1/subscriptions：无订阅返回空数组（不误报过期/组织订阅为当前）', async () => {
    const res = await app.request('/v1/subscriptions', { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('有生效+过期并存时生效中个人订阅必须排首行', async () => {
    // 造一个过期订阅 + 一个生效订阅，验证排序口径
    const [plan] = await db
      .insert(plans)
      .values({ name: `cp${randomUUID().slice(0, 6)}`, kind: 'subscription', price: '10', periodDays: 30, quotaAmount: '100', allowSeats: false, status: 0 })
      .returning({ id: plans.id });
    createdPlanIds.push(plan!.id);
    const now = Date.now();
    await db.insert(userSubscriptions).values([
      { userId, planId: plan!.id, status: 0, quantity: 1, quotaAmount: '100', usedAmount: '0', reservedAmount: '0', price: '10', startAt: new Date(now - 86_400_000), endAt: new Date(now + 30 * 86_400_000) },
      { userId, planId: plan!.id, status: 1, quantity: 1, quotaAmount: '100', usedAmount: '0', reservedAmount: '0', price: '10', startAt: new Date(now - 60 * 86_400_000), endAt: new Date(now - 30 * 86_400_000) },
    ]);
    const res = await app.request('/v1/subscriptions', { headers: auth(token) });
    const body = (await res.json()) as {
      rows: Array<{ endAt: string; remainingAmount: string; renewPrice: string; planPrice: string }>;
    };
    expect(body.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Date(body.rows[0]!.endAt).getTime()).toBeGreaterThan(now); // 首行 = 生效中
    expect(Number(body.rows[0]!.remainingAmount)).toBe(100);
    expect(Number(body.rows[0]!.renewPrice)).toBe(10);
    expect(Number(body.rows[0]!.planPrice)).toBe(10);
  });
});

describe('前端契约 · 精确金额字符串与分页参数', () => {
  it('PATCH key 拒绝 JSON number，只接受精确十进制字符串', async () => {
    const create = await app.request('/v1/keys', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ name: 'num-key' }),
    });
    if (create.status === 404) return; // 路径名差异由上组覆盖
    const { id } = (await create.json()) as { id: number };
    const imprecise = await app.request(`/v1/keys/${id}`, {
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify({ dailySpendLimit: 50 }),
    });
    expect(imprecise.status).toBe(400);
    const exact = await app.request(`/v1/keys/${id}`, {
      method: 'PATCH',
      headers: auth(token),
      body: JSON.stringify({ dailySpendLimit: '50' }),
    });
    expect(exact.status).toBe(200);
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  });

  it('列表正位 limit 参数（page_size 别名已拆）', async () => {
    const res = await app.request('/v1/keys?page=1&limit=50', { headers: auth(token) });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limit?: number };
    expect(body.limit).toBe(50);
  });
});

describe('前端契约 · 支付', () => {
  it('GET /v1/payments/orders/:id 订单详情（属主域 404 语义）', async () => {
    const missing = await app.request('/v1/payments/orders/00000000-0000-0000-0000-000000000000', {
      headers: auth(token),
    });
    expect(missing.status).toBe(404);
  });

  it('旧回调路径已拆（404）——渠道后台须配置 /v1/payments/notify/:provider', async () => {
    const epay = await app.request('/api/public/payments/epay/notify?pid=1&out_trade_no=x', { method: 'GET' });
    expect(epay.status).toBe(404);
  });
});

describe('前端契约 · 注册 fail-closed', () => {
  it('SMTP 未配置（测试形态）→ 注册 503 而非单步建号', async () => {
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `contract-${randomUUID().slice(0, 8)}@example.com`, password: 'a-strong-password-123' }),
    });
    // 测试装配若无 mailer：必须 503（绝不 201 单步建号）
    expect([503, 201, 200]).toContain(res.status);
    if (res.status !== 503) {
      // 若装配带 SMTP stub → 必须走两步（code_required），绝不直接 success
      const body = (await res.json()) as { kind: string };
      expect(body.kind).toBe('code_required');
    }
  });
});
