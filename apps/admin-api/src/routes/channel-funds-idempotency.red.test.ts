import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  admins,
  auditLogs,
  channelRecharges,
  channels,
  providers,
} from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { channelFundsRoutes } from './channel-funds.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 红测（P2-4 幂等部分）：渠道入货/调账不走幂等体系。
 *
 * 用户侧资金操作（调账/赠送/订阅）经 fund_operations 幂等收据；channel-funds
 * 的 recharge/adjust 却裸奔——同 Idempotency-Key 重放会重复累加 upstream_budget
 * （网络重试/管理端双击 = 重复入账）。修法：复用同一 fund_operations 机制：
 * 带 Idempotency-Key 头重放返回首次结果（预算只加一次）；不同 body 同 key → 409。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
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

const PREFIX = 'p1led-chfunds';

describe('渠道入货/调账幂等（P2-4 红测）', () => {
  it('同 Idempotency-Key 重放返回首次结果且 upstream_budget 只加一次；不同 body 同 key → 409', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const [admin] = await db
      .insert(admins)
      .values({ email: `${PREFIX}-admin-${suffix}@test.local`, passwordHash: 'x' })
      .returning({ id: admins.id });
    const [provider] = await db
      .insert(providers)
      .values({ name: `${PREFIX}-p-${suffix}`, baseUrl: 'https://p2.test' })
      .returning({ id: providers.id });
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id,
        name: `${PREFIX}-c-${suffix}`,
        apiKeyEnc: 'enc',
        upstreamBudget: '0',
      })
      .returning({ id: channels.id });
    const channelId = channel!.id;
    const app = makeAdminTestApp(
      { '/channel-funds': channelFundsRoutes(makeServices(db), 1024 * 1024) },
      { adminId: admin!.id },
    );
    const key = `${PREFIX}-recharge-${suffix}`;

    try {
      const post = (path: string, body: unknown, idemKey?: string) =>
        app.request(`/api/admin/channel-funds/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(idemKey ? { 'idempotency-key': idemKey } : {}),
          },
          body: JSON.stringify(body),
        });

      // 首次入货 100 → 预算 100
      const first = await post('recharge', { channelId, amount: 100, remark: 'p2 首次' }, key);
      expect(first.status).toBe(200);
      const fb = (await first.json()) as { rechargeId: number; balanceAfter: string; replayed: boolean };
      expect(fb.balanceAfter).toBe('100.000000000000000000');
      expect(fb.replayed).toBe(false);

      // 同 key 同 body 重放 → 返回首次结果，预算不得二次累加
      const replay = await post('recharge', { channelId, amount: 100, remark: 'p2 首次' }, key);
      expect(replay.status).toBe(200);
      const rb = (await replay.json()) as { rechargeId: number; balanceAfter: string; replayed: boolean };
      expect(rb.replayed).toBe(true);
      expect(rb.rechargeId).toBe(fb.rechargeId);
      expect(rb.balanceAfter).toBe('100.000000000000000000');

      // 不同 body 同 key → 409 幂等冲突
      const conflict = await post('recharge', { channelId, amount: 200 }, key);
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );

      // 调账同样幂等：-30 重放只扣一次 → 预算 70
      const adjustKey = `${PREFIX}-adjust-${suffix}`;
      const adjust1 = await post('adjust', { channelId, amount: -30 }, adjustKey);
      expect(adjust1.status).toBe(200);
      const adjust2 = await post('adjust', { channelId, amount: -30 }, adjustKey);
      expect(adjust2.status).toBe(200);
      expect(((await adjust2.json()) as { replayed: boolean }).replayed).toBe(true);

      // 最终：预算 = 100 - 30 = 70；入货流水 1 条、调账流水 1 条
      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
        columns: { upstreamBudget: true },
      });
      expect(ch!.upstreamBudget).toBe('70.000000000000000000');
      const rows = await db
        .select({ type: channelRecharges.type })
        .from(channelRecharges)
        .where(eq(channelRecharges.channelId, channelId));
      expect(rows.filter((r) => r.type === 'recharge')).toHaveLength(1);
      expect(rows.filter((r) => r.type === 'adjust')).toHaveLength(1);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.adminId, admin!.id));
      await db.delete(channelRecharges).where(eq(channelRecharges.channelId, channelId));
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, provider!.id));
      await db.delete(admins).where(eq(admins.id, admin!.id));
    }
  });
});
