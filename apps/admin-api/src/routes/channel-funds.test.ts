import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { admins, channels, channelRecharges, providers, users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { channelFundsRoutes } from './channel-funds.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 渠道资金（入货/调账）集成：POST /api/admin/channel-funds/{recharge,adjust} + GET 列表。
 * 验证：入货累加额度并记订单号+凭证+余额快照；调账正负原子改额度（不可调负）；列表回显操作人。
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

/** 建一个上游供应商 + 渠道（用于测试） */
async function createChannel(upstreamBudget: string): Promise<{ providerId: number; channelId: number }> {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const [provider] = await db
    .insert(providers)
    .values({ name: `cf-p-${suffix}`, baseUrl: 'https://cf.test' })
    .returning({ id: providers.id });
  const [channel] = await db
    .insert(channels)
    .values({ providerId: provider!.id, name: `cf-ch-${suffix}`, apiKeyEnc: 'enc', upstreamBudget })
    .returning({ id: channels.id });
  return { providerId: provider!.id, channelId: channel!.id };
}

describe('渠道资金（入货/调账）集成', () => {
  it('入货累加额度并记订单号+凭证+余额快照；调账正负原子改额度；列表回显', async (context) => {
    if (!connected) return context.skip();
    const [admin] = await db
      .insert(admins)
      .values({ email: `cf-admin-${Date.now()}@test.local`, passwordHash: 'x' })
      .returning({ id: admins.id });
    const { providerId, channelId } = await createChannel('0');
    const app = makeAdminTestApp(
      { '/channel-funds': channelFundsRoutes(makeServices(db), 1024 * 1024) },
      { adminId: admin!.id },
    );
    try {
      // 入货 100 元 + 订单号 + 凭证（1x1 png base64）
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const recharge = await app.request('/api/admin/channel-funds/recharge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId, amount: 100, orderNo: 'PAY-2024-001', voucherDataUrl: png, remark: '8月上游充值' }),
      });
      expect(recharge.status).toBe(200);
      const rb = (await recharge.json()) as { rechargeId: number; balanceAfter: string };
      expect(rb.balanceAfter).toBe('100.000000000000000000');

      // 调账 -30 → 额度 70
      const adjust = await app.request('/api/admin/channel-funds/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId, amount: -30, remark: '对账修正' }),
      });
      expect(adjust.status).toBe(200);
      const ab = (await adjust.json()) as { balanceAfter: string };
      expect(ab.balanceAfter).toBe('70.000000000000000000');

      // 调账超扣（-999）→ 400
      const over = await app.request('/api/admin/channel-funds/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId, amount: -999 }),
      });
      expect(over.status).toBe(400);

      // 列表：含入货 + 调账两条，回显操作人/订单号/凭证
      const list = await app.request(`/api/admin/channel-funds?channelId=${channelId}`);
      expect(list.status).toBe(200);
      const lb = (await list.json()) as { list: Array<Record<string, unknown>>; total: number };
      expect(lb.total).toBe(2);
      const rechargeRow = lb.list.find((r) => r.type === 'recharge');
      expect(rechargeRow).toMatchObject({
        channelId,
        amount: '100.000000000000000000',
        balanceAfter: '100.000000000000000000',
        orderNo: 'PAY-2024-001',
        adminId: admin!.id,
      });
      expect(rechargeRow!.voucher).toBeTruthy(); // 凭证 key 已落库
      expect(rechargeRow!.adminEmail).toBeTruthy();

      // 渠道额度最终 = 70
      const ch = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
      expect(ch?.upstreamBudget).toBe('70.000000000000000000');
    } finally {
      await db.delete(channelRecharges).where(eq(channelRecharges.channelId, channelId));
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
      await db.delete(admins).where(eq(admins.id, admin!.id));
    }
  });
});
