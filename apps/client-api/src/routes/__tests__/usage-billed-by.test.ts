import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { usageRoutes } from '../usage.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * 用量列表计费来源拆分（第九轮需求）：GET /api/usage 必须返回
 * billedBy/planAmount/paygAmount——前端据此区分展示（套餐=积分 / 余额=金额）。
 * DB 不变量（usage_logs_amount_split_ck）：amount = plan + payg。
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

describe('GET /api/usage 计费来源拆分', () => {
  it('套餐行 billedBy=plan（planAmount=amount）；余额行 billedBy=payg（paygAmount=amount）', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__ub_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const row = (billedBy: 'plan' | 'payg') => ({
      requestId: randomUUID(),
      userId: u!.id,
      credentialType: 'key',
      externalModel: `ub-${s}`,
      realModel: `ub-${s}-real`,
      channelId: null as unknown as number,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      amount: '0.5',
      planAmount: billedBy === 'plan' ? '0.5' : '0',
      paygAmount: billedBy === 'payg' ? '0.5' : '0',
      upstreamCost: '0.1',
      durationMs: 100,
      statusCode: 0,
      coefficient: '1.000',
      billedBy,
    });
    await db.insert(usageLogs).values([row('plan'), row('payg')]);
    const app = makeClientTestApp(u!.id, { '/usage': usageRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/usage?page=1&page_size=10');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        list?: Array<{ billedBy?: string; planAmount?: string; paygAmount?: string; amount?: string }>;
      };
      const planRow = body.list?.find((r) => r.billedBy === 'plan');
      const paygRow = body.list?.find((r) => r.billedBy === 'payg');
      expect(planRow).toBeDefined();
      expect(Number(planRow?.planAmount)).toBeCloseTo(0.5, 6);
      expect(Number(planRow?.paygAmount)).toBeCloseTo(0, 6);
      expect(paygRow).toBeDefined();
      expect(Number(paygRow?.paygAmount)).toBeCloseTo(0.5, 6);
      expect(Number(paygRow?.planAmount)).toBeCloseTo(0, 6);
      expect(Number(planRow?.amount)).toBeCloseTo(0.5, 6); // 拆分恒等由 DB CHECK 兜底
    } finally {
      await db.delete(usageLogs).where(eq(usageLogs.userId, u!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
