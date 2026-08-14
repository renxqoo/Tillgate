import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, users, userSubscriptions, transactions } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { planAdminRoutes } from './plans.js';
import { userAdminRoutes } from './users.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 套餐参数校验（TDD）：
 *   - kind × periodDays 一致性（包月 1~3650；加油包 0/省略）
 *   - kind 创建后不可变（PATCH 拒绝未知字段 kind → 400）
 *   - 金额必须为有限数且有业务上限
 *   - 删除套餐：存在任何关联订阅（含历史）→ 409，而非 FK 500
 *   - 路径参数非正整数 → 400 INVALID_PARAM
 *   - 调账金额 Infinity → 400（防 numeric 溢出 500）
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function post(app: ReturnType<typeof makeAdminTestApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function patch(app: ReturnType<typeof makeAdminTestApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('套餐参数校验', () => {
  it('包月套餐 periodDays=0 → 400（防「买到立即到期」）', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const r = await post(app, '/api/admin/plans', {
      name: 'val-zero-period',
      price: 10,
      periodDays: 0,
      quotaAmount: 5,
    });
    expect(r.status).toBe(400);
    expect((r.body.error as { code: string }).code).toBe('INVALID_PERIOD_DAYS');
  });

  it('包月套餐缺 periodDays → 400', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const r = await post(app, '/api/admin/plans', { name: 'val-no-period', price: 10, quotaAmount: 5 });
    expect(r.status).toBe(400);
    expect((r.body.error as { code: string }).code).toBe('INVALID_PERIOD_DAYS');
  });

  it('加油包 periodDays=30 → 400；省略 → 201 且落库 0', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const bad = await post(app, '/api/admin/plans', {
      name: 'val-pack-period',
      kind: 'pack',
      price: 10,
      periodDays: 30,
      quotaAmount: 5,
    });
    expect(bad.status).toBe(400);
    expect((bad.body.error as { code: string }).code).toBe('INVALID_PERIOD_DAYS');

    const ok = await post(app, '/api/admin/plans', {
      name: 'val-pack-ok',
      kind: 'pack',
      price: 10,
      quotaAmount: 5,
    });
    expect(ok.status).toBe(201);
    const row = await db.query.plans.findFirst({ where: eq(plans.name, 'val-pack-ok') });
    expect(row!.periodDays).toBe(0);
    await db.delete(plans).where(eq(plans.id, row!.id));
  });

  it('价格 Infinity（JSON 1e999 溢出）→ 400（防 numeric 溢出 500）', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    // JSON 数字 1e999 在 JS 解析为 Infinity；zod finite() 必须拦下
    const res = await app.request('/api/admin/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"val-inf-price","price":1e999,"periodDays":30,"quotaAmount":5}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH 传 kind（不可变）→ 400；合法更新 periodDays 正常', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const created = await post(app, '/api/admin/plans', {
      name: 'val-kind-immutable',
      price: 10,
      periodDays: 30,
      quotaAmount: 5,
    });
    expect(created.status).toBe(201);
    const id = Number(created.body.id);
    try {
      const flip = await patch(app, `/api/admin/plans/${id}`, { kind: 'pack' });
      expect(flip.status).toBe(400);
      expect((flip.body.error as { code: string }).code).toBe('VALIDATION_ERROR');

      const zeroPeriod = await patch(app, `/api/admin/plans/${id}`, { periodDays: 0 });
      expect(zeroPeriod.status).toBe(400);

      const ok = await patch(app, `/api/admin/plans/${id}`, { periodDays: 365 });
      expect(ok.status).toBe(200);
      expect(Number((ok.body as { periodDays: string }).periodDays)).toBe(365);
    } finally {
      await db.delete(plans).where(eq(plans.id, id));
    }
  });

  it('路径参数非正整数 → 400 INVALID_PARAM（不再是 500）', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const r = await patch(app, '/api/admin/plans/abc', { name: 'x' });
    expect(r.status).toBe(400);
    expect((r.body.error as { code: string }).code).toBe('INVALID_PARAM');
  });

  it('删除套餐：存在历史订阅（已取消）→ 409 而非 FK 500', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const created = await post(app, '/api/admin/plans', {
      name: 'val-del-hist',
      price: 10,
      periodDays: 30,
      quotaAmount: 5,
    });
    const planId = Number(created.body.id);
    const [u] = await db
      .insert(users)
      .values({ issuer: 'test', subject: `valplan-${Date.now()}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: u!.id,
        planId,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '5',
        quantity: 1,
        price: '10',
        status: 2, // 已取消（历史）
      })
      .returning({ id: userSubscriptions.id });
    try {
      const res = await app.request(`/api/admin/plans/${planId}`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PLAN_IN_USE');
    } finally {
      await db.delete(userSubscriptions).where(eq(userSubscriptions.id, sub!.id));
      await db.delete(transactions).where(eq(transactions.userId, u!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, u!.id));
      await db.delete(plans).where(eq(plans.id, planId));
    }
  });

  it('调账金额 Infinity / 超上限 → 400；正常小额调账可用', async () => {
    if (!connected) return it.skip('no DB');
    const app = makeAdminTestApp({
      '/plans': planAdminRoutes(makeServices(db)),
      '/users': userAdminRoutes(makeServices(db)),
    });
    const [u] = await db
      .insert(users)
      .values({ issuer: 'test', subject: `valadj-${Date.now()}`, identityProvider: 'local', balance: '100' })
      .returning({ id: users.id });
    try {
      // 字符串 "1e309" 经 z.coerce.number() 变 Infinity → finite() 拦下
      const inf = await post(app, `/api/admin/users/${u!.id}/adjust`, { amount: '1e309' });
      expect(inf.status).toBe(400);
      expect((inf.body.error as { code: string }).code).toBe('VALIDATION_ERROR');

      const huge = await post(app, `/api/admin/users/${u!.id}/adjust`, { amount: 1e10 });
      expect(huge.status).toBe(400);

      const ok = await post(app, `/api/admin/users/${u!.id}/adjust`, { amount: 1 });
      expect(ok.status).toBe(200);
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, u!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
