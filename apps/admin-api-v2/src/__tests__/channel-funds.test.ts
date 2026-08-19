/**
 * 渠道资金语义（v1 channel-funds 三文件的 v2 对位）：
 *   - 入货累加额度 + 订单号/凭证/余额快照落流水；调账正负原子改额度；列表回显
 *   - idempotency red：同 Idempotency-Key 重放返回首次结果且额度只加一次；
 *     同键异参 → 409 idempotency_conflict；调账同样幂等
 *   - recharge-bound red：amount 超 MONEY_MAX → 400 且不触库
 *   - 超扣守卫：调账致负 → 422 insufficient_budget
 *   - 熔断渠道（status=3）进货自动复活为 0
 * 金额断言 Decimal .eq()（numeric(38,18) 尾零不干扰）。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels as channelsTable } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/domain';
import {
  buildTestApp,
  db,
  newAdmin,
  newChannelRow,
  newProviderRow,
  uid,
} from './helpers.js';

/** 1x1 PNG 的 base64 data URL（最小合法凭证） */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function budgetOf(channelId: number): Promise<string> {
  const [row] = await db
    .select({ budget: channelsTable.upstreamBudget })
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId));
  return row!.budget;
}

describe('进货/调账 happy path', () => {
  it('入货累加 + 凭证落键 + 流水快照；调账正负原子；列表回显操作人', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId);

    const recharge = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 100, orderNo: `PAY-${uid('x')}`, voucherDataUrl: PNG_DATA_URL, remark: '测试入货' },
      headers: { 'idempotency-key': uid('rc') },
    });
    expect(recharge.status).toBe(200);
    expect(new Decimal(((await recharge.json()) as { balanceAfter: string }).balanceAfter).eq(100)).toBe(true);

    const adjustDown = await request('/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: -30 },
      headers: { 'idempotency-key': uid('adj') },
    });
    expect(adjustDown.status).toBe(200);
    expect(new Decimal(((await adjustDown.json()) as { balanceAfter: string }).balanceAfter).eq(70)).toBe(true);

    // 超扣（调后为负）→ 422 insufficient_budget
    const overDraw = await request('/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: -999 },
      headers: { 'idempotency-key': uid('adj') },
    });
    expect(overDraw.status).toBe(422);
    expect(((await overDraw.json()) as { error: { code: string } }).error.code).toBe('insufficient_budget');

    // 列表：2 行流水 + 凭证键 + 操作人邮箱
    const list = (await (
      await request(`/v1/channel-funds?channelId=${channelId}`, { token })
    ).json()) as {
      rows: Array<{
        type: string;
        amount: string;
        balanceAfter: string;
        voucher: string | null;
        adminEmail: string | null;
        channelName: string;
      }>;
      total: number;
    };
    expect(list.total).toBe(2);
    const rechargeRow = list.rows.find((r) => r.type === 'recharge')!;
    expect(rechargeRow.voucher).toBeTruthy();
    expect(rechargeRow.adminEmail).toBeTruthy();
    expect(rechargeRow.channelName).toBeTruthy();
    expect(new Decimal(rechargeRow.amount).eq(100)).toBe(true);

    expect(new Decimal(await budgetOf(channelId)).eq(70)).toBe(true);
  });

  it('熔断渠道（status=3）进货自动复活为 0', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId, { status: 3 });

    const res = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 10 },
      headers: { 'idempotency-key': uid('rc') },
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    expect(row!.status).toBe(0);
  });
});

describe('幂等 red：同键重放只动一次钱', () => {
  it('同 Idempotency-Key 同参 → replayed + 同 rechargeId + 额度只加一次；异参同键 → 409', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId);
    const key = uid('idem');

    const first = (await (
      await request('/v1/channel-funds/recharge', {
        token,
        body: { channelId, amount: 100 },
        headers: { 'idempotency-key': key },
      })
    ).json()) as { rechargeId: number; balanceAfter: string; replayed: boolean };
    expect(first.replayed).toBe(false);
    expect(new Decimal(first.balanceAfter).eq(100)).toBe(true);

    const replay = (await (
      await request('/v1/channel-funds/recharge', {
        token,
        body: { channelId, amount: 100 },
        headers: { 'idempotency-key': key },
      })
    ).json()) as { rechargeId: number; balanceAfter: string; replayed: boolean };
    expect(replay.replayed).toBe(true);
    expect(replay.rechargeId).toBe(first.rechargeId);
    expect(new Decimal(replay.balanceAfter).eq(100)).toBe(true); // 未双加

    const conflict = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 200 },
      headers: { 'idempotency-key': key },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('idempotency_conflict');

    // 调账同样幂等
    const adjKey = uid('adj');
    const adj1 = await request('/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: -30 },
      headers: { 'idempotency-key': adjKey },
    });
    expect(adj1.status).toBe(200);
    const adj2 = (await (
      await request('/v1/channel-funds/adjust', {
        token,
        body: { channelId, amount: -30 },
        headers: { 'idempotency-key': adjKey },
      })
    ).json()) as { replayed: boolean };
    expect(adj2.replayed).toBe(true);

    expect(new Decimal(await budgetOf(channelId)).eq(70)).toBe(true); // 100 − 30（只扣一次）
  });
});

describe('red：amount 超 MONEY_MAX → 400 且不触库', () => {
  it('1e21 → 400；预算字节不变', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId);
    await db.update(channelsTable).set({ upstreamBudget: '10' }).where(eq(channelsTable.id, channelId));

    const res = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 1e21 },
      headers: { 'idempotency-key': uid('rc') },
    });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    expect(new Decimal(row!.upstreamBudget).eq(10)).toBe(true); // 未触碰
  });
});

describe('凭证边界', () => {
  it('非图片 MIME / 超大凭证 → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId);

    const badMime = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 10, voucherDataUrl: 'data:text/plain;base64,aGk=' },
      headers: { 'idempotency-key': uid('rc') },
    });
    expect(badMime.status).toBe(400);
    expect(((await badMime.json()) as { error: { code: string } }).error.code).toBe('invalid_voucher');

    // 凭证可回读（生产存储键换读）
    const ok = await request('/v1/channel-funds/recharge', {
      token,
      body: { channelId, amount: 10, voucherDataUrl: PNG_DATA_URL },
      headers: { 'idempotency-key': uid('rc') },
    });
    expect(ok.status).toBe(200);
    const list = (await (
      await request(`/v1/channel-funds?channelId=${channelId}`, { token })
    ).json()) as { rows: Array<{ voucher: string | null }> };
    const voucherKey = list.rows[0]!.voucher!;
    const readBack = await request(`/v1/vouchers/${voucherKey}`, { token });
    expect(readBack.status).toBe(200);
    expect(readBack.headers.get('content-type')).toBe('image/png');
    // 键穿越 → 404
    expect((await request('/v1/vouchers/..%2F..%2Fetc%2Fpasswd', { token })).status).toBe(404);
  });
});
