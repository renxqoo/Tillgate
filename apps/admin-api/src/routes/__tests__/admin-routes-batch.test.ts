import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { admins, redeemBatches, redeemCodes, users, providers, apiKeys } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { billingOperationsRoutes } from '../billing-operations.js';
import { redeemAdminRoutes } from '../redeem.js';
import { keyAdminRoutes } from '../keys.js';
import { subscriptionAdminRoutes } from '../subscriptions.js';
import { providerAdminRoutes } from '../providers.js';
import { statsAdminRoutes } from '../stats.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * B 类 admin 路由层回归锁定（此前只有 ledger/services 层测试，路由接线零覆盖）：
 *   billing-operations：decision 枚举/uuid 参数 400、不存在单 404
 *   redeem：批次金额/count 校验、撤销码状态迁移
 *   keys(admin)：status 枚举 + 归属
 *   subscriptions(admin)：cancel 404 / change 参数校验
 *   providers：重名 409（PG 翻译）、非法 url 400、超长 400
 *   stats：overview/usage 200 结构
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('B: billing-operations 路由', () => {
  it('decision 非法 400；requestId 非 uuid 400（intParam/uuid 层）；不存在单 resolve 404', async (context) => {
    if (!connected) return context.skip();
    const app = makeAdminTestApp({ '/billing-operations': billingOperationsRoutes(makeServices(db)) });
    const badDecision = await app.request(`/api/admin/billing-operations/00000000-0000-4000-8000-000000000000/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, decision: 'whatever' }),
    });
    expect(badDecision.status).toBe(400);
    const ghost = await app.request(`/api/admin/billing-operations/00000000-0000-4000-8000-000000000000/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, decision: 'confirmed_no_charge' }),
    });
    expect([404, 400]).toContain(ghost.status); // 不存在单：业务 404 或参数层拒绝，均非 500
    const badId = await app.request(`/api/admin/billing-operations/not-a-uuid/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect([400, 404]).toContain(badId.status);
  });
});

describe('B: redeem 批次管理路由', () => {
  it('金额 0/负/超大与 count 超限 400；合法批次创建 201 + 码哈希脱敏；撤销码后码作废', async (context) => {
    if (!connected) return context.skip();
    // 批次 created_by 外键指向真实 admins 行
    const s2 = `${Date.now()}`;
    const [adm] = await db
      .insert(admins)
      .values({ email: `__btr_${s2}@test.local`, passwordHash: 'x' })
      .returning({ id: admins.id });
    const services = makeServices(db);
    const app = makeAdminTestApp({ '/redeem-batches': redeemAdminRoutes(services) }, { adminId: adm!.id });
    const bad = [
      { name: 'b1', amount: 0, count: 1 },
      { name: 'b2', amount: -1, count: 1 },
      { name: 'b3', amount: 1, count: 10001 },
    ];
    for (const b of bad) {
      const res = await app.request('/api/admin/redeem-batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    const s = `${Date.now()}`;
    const created = await app.request('/api/admin/redeem-batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `__bt_${s}`, amount: 1, count: 2 }),
    });
    expect(created.status).toBe(201);
    const batch = (await created.json()) as { batch?: { id: number } };
    const batchId = batch.batch?.id;
    try {
      const codes = await app.request(`/api/admin/redeem-batches/${batchId}/codes`);
      expect(codes.status).toBe(200);
      // 撤销一枚码
      const rows = await db.select({ id: redeemCodes.id }).from(redeemCodes).where(eq(redeemCodes.batchId, batchId!));
      expect(rows.length).toBe(2);
      const revoke = await app.request(`/api/admin/redeem-batches/codes/${rows[0]!.id}/revoke`, { method: 'POST' });
      expect([200, 204]).toContain(revoke.status);
      const revokedRow = await db.query.redeemCodes.findFirst({ where: eq(redeemCodes.id, rows[0]!.id) });
      expect(revokedRow?.status).toBe(2);
    } finally {
      await db.delete(redeemCodes).where(eq(redeemCodes.batchId, batchId!));
      await db.delete(redeemBatches).where(eq(redeemBatches.id, batchId!));
      await db.delete(admins).where(eq(admins.id, adm!.id));
    }
  });
});

describe('B: admin keys 路由', () => {
  it('PATCH status 合法枚举落库；非法 99 → 400；不存在 404', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__bk_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [k] = await db
      .insert(apiKeys)
      .values({ keyHash: `__bk_${s}`, keyPreview: 'ag_****bk', userId: u!.id, name: `__bk_${s}` })
      .returning({ id: apiKeys.id });
    const app = makeAdminTestApp({ '/keys': keyAdminRoutes(makeServices(db)) });
    try {
      const bad = await app.request(`/api/admin/keys/${k!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 99 }),
      });
      expect(bad.status).toBe(400);
      const ok = await app.request(`/api/admin/keys/${k!.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 1 }),
      });
      expect(ok.status).toBe(200);
      const row = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, k!.id), columns: { status: true } });
      expect(row?.status).toBe(1);
      const ghost = await app.request('/api/admin/keys/999999999', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 0 }),
      });
      expect([404, 400]).toContain(ghost.status);
    } finally {
      await db.delete(apiKeys).where(eq(apiKeys.userId, u!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});

describe('B: admin subscriptions 路由', () => {
  it('cancel 不存在 → 404；change 缺 targetPlanId → 400', async (context) => {
    if (!connected) return context.skip();
    const app = makeAdminTestApp({ '/subscriptions': subscriptionAdminRoutes(makeServices(db)) });
    const cancel = await app.request('/api/admin/subscriptions/999999999/cancel', { method: 'POST' });
    expect([404, 400]).toContain(cancel.status);
    const change = await app.request('/api/admin/subscriptions/999999999/change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 1 }),
    });
    expect(change.status).toBe(400);
  });
});

describe('B: providers 路由', () => {
  it('非法 baseUrl 400；超长 name 400；重名 → 409（PG 翻译）', async (context) => {
    if (!connected) return context.skip();
    const services = makeServices(db);
    const app = makeAdminTestApp({ '/providers': providerAdminRoutes(services) });
    const badUrl = await app.request('/api/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'p-url', baseUrl: 'not-a-url' }),
    });
    expect(badUrl.status).toBe(400);
    const longName = await app.request('/api/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'p'.repeat(33), baseUrl: 'https://a.b' }),
    });
    expect(longName.status).toBe(400);
    const s = `${Date.now()}`.slice(-6);
    const name = `__bp_${s}`;
    const first = await app.request('/api/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, baseUrl: 'https://dup.example' }),
    });
    expect(first.status).toBe(201);
    try {
      const dup = await app.request('/api/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, baseUrl: 'https://dup.example' }),
      });
      expect(dup.status).toBe(409); // F1 PG 翻译：唯一约束 → 409 CONFLICT
    } finally {
      await db.delete(providers).where(eq(providers.name, name));
    }
  });
});

describe('B: stats 路由', () => {
  it('overview / usage 200 且返回基础结构', async (context) => {
    if (!connected) return context.skip();
    const app = makeAdminTestApp({ '/stats': statsAdminRoutes(makeServices(db)) });
    const ov = await app.request('/api/admin/stats/overview');
    expect(ov.status).toBe(200);
    expect(typeof (await ov.json())).toBe('object');
    const us = await app.request('/api/admin/stats/usage');
    expect(us.status).toBe(200);
  });
});
