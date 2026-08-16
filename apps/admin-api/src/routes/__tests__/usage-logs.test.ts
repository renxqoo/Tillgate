import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, usageLogs } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { usageLogAdminRoutes } from '../usage-logs.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * 管理端用量明细（2026-08-17 估算结算政策配套）：
 *   - 列表透出 estimated/estimateReason（估算扣款一等字段）
 *   - estimated 过滤即「估算扣款观测入口」（true/false 语义正确——'false' 不得变 true）
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

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

describe('管理端用量明细（估算标记透出）', () => {
  it('列表含 estimated/estimateReason；estimated=false 过滤不误吞（字符串布尔解析）', async (context) => {
    if (!connected) return context.skip();
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const [user] = await db
      .insert(users)
      .values({ issuer: 'test', subject: `ul-${suffix}`, identityProvider: 'local', displayName: 'ul' })
      .returning({ id: users.id });
    const mk = (estimated: boolean, reason: string | null) => ({
      userId: user!.id,
      requestId: crypto.randomUUID(),
      credentialType: 'key',
      billedBy: 'payg',
      coefficient: '1.000',
      status: 0,
      externalModel: 'ul-model',
      realModel: 'ul-model-real',
      inputTokens: 10,
      outputTokens: 5,
      inputPrice: '1000',
      outputPrice: '2000',
      cacheInputPrice: '100',
      amount: '0.02',
      calculatedAmount: '0.02',
      planAmount: '0',
      paygAmount: '0.02',
      upstreamCost: '0.01',
      durationMs: 5,
      estimated,
      estimateReason: reason,
    });
    const app = makeAdminTestApp({ '/usage-logs': usageLogAdminRoutes(makeServices(db)) });
    try {
      await db.insert(usageLogs).values([
        mk(true, 'usage_missing_completed'),
        mk(false, null),
      ] as never);
      // 全量：两行都可见，估算行带标记
      const allRes = await app.request('/api/admin/usage-logs?page=1&page_size=50&q=ul-model');
      if (!allRes.ok) throw new Error(`list failed: ${allRes.status} ${await allRes.text()}`);
      const all = (await allRes.json()) as { list: Array<{ estimated: boolean; estimateReason: string | null }>; total: number };
      expect(all.total).toBe(2);
      const est = all.list.find((r) => r.estimated);
      const real = all.list.find((r) => !r.estimated);
      expect(est?.estimateReason).toBe('usage_missing_completed');
      expect(real?.estimateReason).toBeNull();
      // estimated=false 过滤：字符串 'false' 不得被解析成 true（coerce 陷阱回归）
      const onlyReal = (await (
        await app.request('/api/admin/usage-logs?page=1&page_size=50&q=ul-model&estimated=false')
      ).json()) as { list: Array<{ estimated: boolean }>; total: number };
      expect(onlyReal.total).toBe(1);
      expect(onlyReal.list.every((r) => r.estimated === false)).toBe(true);
      // estimated=true 过滤
      const onlyEst = (await (
        await app.request('/api/admin/usage-logs?page=1&page_size=50&q=ul-model&estimated=true')
      ).json()) as { list: Array<{ estimated: boolean }>; total: number };
      expect(onlyEst.total).toBe(1);
      expect(onlyEst.list.every((r) => r.estimated === true)).toBe(true);
    } finally {
      await db.delete(usageLogs).where(eq(usageLogs.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });
});
