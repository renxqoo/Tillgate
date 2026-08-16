import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, users, transactions, userSubscriptions } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { subscriptionRoutes } from '../subscriptions.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * C3 红测：购买接口传「加油包」planId（kind='pack'，/api/plans 不展示但 id 可猜）
 * 时，ledger 抛 not_a_pack，client-api 的 mapError 无该分支 → 500。
 * 必须映射为 400 业务错误（错误语义分级），不得裸奔 500。
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

describe('RED C3: POST /api/subscriptions 传加油包 planId → 400（不得 500）', () => {
  it('kind=pack 的 planId → 400 NOT_A_PACK', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__c3u_${s}`, identityProvider: 'local', balance: '100' })
      .returning({ id: users.id });
    const [pack] = await db
      .insert(plans)
      .values({
        name: `__c3pack_${s}`.slice(0, 32),
        kind: 'pack',
        price: '10',
        periodDays: 30,
        quotaAmount: '10',
        sortOrder: 1,
        status: 0,
      })
      .returning({ id: plans.id });
    try {
      const app = makeClientTestApp(u!.id, { '/subscriptions': subscriptionRoutes(makeServices(db)) });
      const res = await app.request('/api/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: pack!.id }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('NOT_A_PACK');
      // 不得产生任何订阅/扣款
      const subs = await db.select({ id: userSubscriptions.id }).from(userSubscriptions).where(eq(userSubscriptions.userId, u!.id));
      expect(subs.length).toBe(0);
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, u!.id));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, u!.id));
      await db.delete(plans).where(eq(plans.id, pack!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
