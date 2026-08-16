import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, users, userSubscriptions, apps } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { appRoutes } from '../apps.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * W1 红测：POST /api/apps 绑定 subscriptionId 时必须校验归属
 * （与 keys.ts 的 assertCanUseSubscription 同语义——B 不得把 App 绑到 A 的订阅）。
 * 授权时虽有兜底（billing-flow owner/成员校验），但创建面必须一致拒绝，
 * 否则留下「看似绑定成功、调用必 402」的脏状态，且纵深防御只剩一层。
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
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

describe('POST /api/apps 订阅归属校验（W1）', () => {
  it('B 用 A 的 subscriptionId 建 App → 403，不得 201', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [a] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__w1a_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [b] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__w1b_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [plan] = await db
      .insert(plans)
      .values({
        name: `__w1plan_${s}`.slice(0, 32),
        kind: 'subscription',
        price: '1',
        periodDays: 30,
        quotaAmount: '1',
        sortOrder: 1,
        status: 0,
      })
      .returning({ id: plans.id });
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: a!.id,
        planId: plan!.id,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '1',
        quantity: 1,
        price: '1',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    try {
      const appB = makeClientTestApp(b!.id, { '/apps': appRoutes(makeServices(db)) });
      const res = await appB.request('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `w1-app-${s}`, subscriptionId: sub!.id }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('SUBSCRIPTION_FORBIDDEN');
      // 不得留下绑定脏数据
      const bound = await db.select({ id: apps.id }).from(apps).where(eq(apps.subscriptionId, sub!.id));
      expect(bound.length).toBe(0);
      // 对照：订阅 owner 本人绑定成功
      const appA = makeClientTestApp(a!.id, { '/apps': appRoutes(makeServices(db)) });
      const resA = await appA.request('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `w1-app-own-${s}`, subscriptionId: sub!.id }),
      });
      expect(resA.status).toBe(201);
    } finally {
      await db.delete(apps).where(eq(apps.userId, b!.id)).catch(() => {});
      await db.delete(apps).where(eq(apps.userId, a!.id)).catch(() => {});
      await db.delete(userSubscriptions).where(eq(userSubscriptions.id, sub!.id)).catch(() => {});
      await db.delete(plans).where(eq(plans.id, plan!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, b!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, a!.id)).catch(() => {});
    }
  });
});
