import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { channels, providers } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { channelFundsRoutes } from '../channel-funds.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * 回归护栏（F6）：渠道充值 amount 上界。
 * schema 层 MONEY_MAX 快速拒绝（与调账对齐）；此前仅靠全局 PG 22003→400
 * 翻译兜底（packages/http errors.ts），行为已是 400，本测锁定该语义不再回退。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

let connected = false;
beforeAll(async () => {
  try {
    await db.query.channels.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

const PREFIX = 'funds-bound';

describe('渠道充值金额上界（F6 红测）', () => {
  it('amount 超 MONEY_MAX → 400，不触碰数据库', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = randomUUID().slice(0, 8);
    const [provider] = await db
      .insert(providers)
      .values({ name: `${PREFIX}-p-${suffix}`, baseUrl: 'https://upstream.test' })
      .returning({ id: providers.id });
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id,
        name: `${PREFIX}-c-${suffix}`,
        apiKeyEnc: 'test-enc',
        upstreamBudget: '10',
      })
      .returning({ id: channels.id, upstreamBudget: channels.upstreamBudget });
    const app = makeAdminTestApp({ '/channel-funds': channelFundsRoutes(makeServices(db), 1000) });
    try {
      const res = await app.request('/api/admin/channel-funds/recharge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: channel!.id, amount: 1e21 }),
      });
      expect(res.status).toBe(400);
      // 拒绝后预算不变
      const after = await db.query.channels.findFirst({
        where: eq(channels.id, channel!.id),
        columns: { upstreamBudget: true },
      });
      expect(after!.upstreamBudget).toBe(channel!.upstreamBudget);
    } finally {
      await db.delete(channels).where(eq(channels.id, channel!.id));
      await db.delete(providers).where(eq(providers.id, provider!.id));
    }
  });
});
