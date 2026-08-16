import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { billingRequests, users } from '@ai-gateway/db/schema';
import { createBillingAutoReleaser, createBillingOperations } from '../index.js';

/**
 * 审计 P0-5（放行侧）：小额自动放行通道没有最小滞留时长条件——刚被
 * recoverOnce 转成 uncertain 0 秒的单会被同一 tick 立即免单释放，
 * 与在途结算竞态（上游已成功、收据正在路上）。时效通道（R11-B）有
 * updatedAt 条件，小额通道必须同样只处理「滞留」单。
 */
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('小额自动放行 — 最小滞留时长', () => {
  it('刚转 uncertain 的单不立即放行；滞留超过阈值的才放', async () => {
    if (!connected) return it.skip('no DB');
    const tag = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: randomUUID(),
        identityProvider: 'local',
        email: `p05-${tag}@test.local`,
        balance: '100',
        reservedBalance: '0.05',
      })
      .returning({ id: users.id });
    const freshId = randomUUID();
    const agedId = randomUUID();
    try {
      const row = (requestId: string) => ({
        requestId,
        userId: user!.id,
        status: 'uncertain' as const,
        revision: 0,
        reservedAmount: '0.05',
        planReservedAmount: null,
        stream: false,
        quote: { maxOutputTokens: 100, candidates: [] },
        authorizationFingerprint: randomUUID().replace(/-/g, ''),
      });
      await db.insert(billingRequests).values(row(freshId));
      await db.insert(billingRequests).values(row(agedId));
      // aged：updatedAt 回拨 2 小时
      await db
        .update(billingRequests)
        .set({ updatedAt: new Date(Date.now() - 2 * 3_600_000) })
        .where(eq(billingRequests.requestId, agedId));

      const operations = createBillingOperations({ db });
      const releaser = createBillingAutoReleaser({
        db,
        operations,
        config: { maxAmount: '0.1', batchSize: 50, minAgeMs: 60_000 },
      });
      const result = await releaser.runOnce();
      expect(result.released).toBe(1);

      const [fresh] = await db
        .select({ status: billingRequests.status })
        .from(billingRequests)
        .where(eq(billingRequests.requestId, freshId));
      const [aged] = await db
        .select({ status: billingRequests.status })
        .from(billingRequests)
        .where(eq(billingRequests.requestId, agedId));
      expect(fresh?.status).toBe('uncertain'); // 刚转的不动
      expect(aged?.status).toBe('released'); // 滞留的放行
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });
});
