/**
 * 渠道资金用例（v1 channel-funds.test.ts 语义等价迁移）：
 * 幂等（同键同参重放回执/同键异参冲突）/ 进货复活熔断 / 调账守卫 / 凭证字节不进指纹。
 */
import { describe, expect, it } from 'vitest';
import { rechargeChannel } from '../src/application/channels/recharge-channel';
import { adjustChannel } from '../src/application/channels/adjust-channel';
import { listRecharges } from '../src/application/channels/list-recharges';
import {
  adminCtx,
  createMemoryChannelStore,
  createMemoryOperationsStore,
  createMemoryVoucherStorage,
  createMemoryAudit,
  createMemoryDb,
} from './memory';

function setup() {
  const db = createMemoryDb();
  const channels = createMemoryChannelStore(
    () => 'prov',
    [
      {
        id: 7,
        providerId: 1,
        name: 'funds-ch',
        apiKeyEnc: 'fake-enc:k',
        baseUrlOverride: null,
        models: null,
        weight: 1,
        priority: 0,
        status: 0,
        failCount: 0,
        cooldownUntil: null,
        rpmLimit: null,
        tpmLimit: null,
        upstreamBudget: '100',
        upstreamReserved: '0',
        upstreamThreshold: null,
      },
    ],
  );
  const operations = createMemoryOperationsStore();
  const voucher = createMemoryVoucherStorage();
  const audit = createMemoryAudit();
  const base = {
    db,
    stores: { channel: channels.store, operations: operations.store },
    voucherStorage: voucher,
    voucherMaxBytes: 1024,
    audit: audit.sink,
  };
  return { base, channels, operations, voucher, audit };
}

describe('进货（幂等 operations 用例）', () => {
  it('进货落余额 + 流水 + 审计；同键同参重放回执不重复入账', async () => {
    const { base, channels, operations, audit } = setup();
    const first = await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '50',
      operationId: 'op-recharge-1',
    });
    expect(first).toMatchObject({ ok: true, replayed: false, balanceAfter: '150' });
    expect(channels.recharges).toHaveLength(1);

    const replay = await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '50',
      operationId: 'op-recharge-1',
    });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      balanceAfter: '150',
      rechargeId: first.rechargeId,
    });
    expect(channels.recharges).toHaveLength(1); // 重放不重复入账
    expect(channels.rows.get(7)!.upstreamBudget).toBe('150');
    expect(operations.rows.get('op-recharge-1')!.receipt).toMatchObject({
      rechargeId: first.rechargeId,
    });
    expect(audit.entries.filter((e) => e.action === 'channel.recharge')).toHaveLength(2); // 每次调用都审计
  });

  it('同键异参 → operation_conflict；坏键形状 → invalid_operation_id', async () => {
    const { base } = setup();
    await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '10',
      operationId: 'op-key',
    });
    await expect(
      rechargeChannel(base, { ctx: adminCtx(), channelId: 7, amount: '20', operationId: 'op-key' }),
    ).rejects.toMatchObject({ code: 'control_plane.operation_conflict' });
    await expect(
      rechargeChannel(base, {
        ctx: adminCtx(),
        channelId: 7,
        amount: '1',
        operationId: '/bad-key',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_operation_id' });
  });

  it('进货自动复活熔断渠道（status 3 → 0）；渠道不存在 → channel_not_found', async () => {
    const { base, channels } = setup();
    channels.rows.get(7)!.status = 3;
    await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '5',
      operationId: 'op-revive',
    });
    expect(channels.rows.get(7)!.status).toBe(0);
    await expect(
      rechargeChannel(base, {
        ctx: adminCtx(),
        channelId: 999,
        amount: '5',
        operationId: 'op-miss',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.channel_not_found' });
  });

  it('凭证字节不进指纹：同参（含凭证）重放命中同一操作，余额只加一次', async () => {
    const { base, voucher, channels } = setup();
    const dataUrl = `data:image/png;base64,${Buffer.from('voucher-bytes').toString('base64')}`;
    const first = await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '1',
      voucherDataUrl: dataUrl,
      operationId: 'op-voucher',
    });
    expect(voucher.saved.size).toBe(1);
    expect(first.replayed).toBe(false);
    // 重放：携带同参（指纹只含 hasVoucher 布尔，不含字节）→ 命中同一操作，业务不重复入账
    const replay = await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '1',
      voucherDataUrl: dataUrl,
      operationId: 'op-voucher',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.rechargeId).toBe(first.rechargeId);
    expect(channels.recharges).toHaveLength(1);
    expect(channels.rows.get(7)!.upstreamBudget).toBe('101');
  });

  it('非法金额/凭证 → invalid_channel_input / invalid_voucher', async () => {
    const { base } = setup();
    await expect(
      rechargeChannel(base, {
        ctx: adminCtx(),
        channelId: 7,
        amount: '1e21',
        operationId: 'op-bad-amt',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_channel_input' });
    await expect(
      rechargeChannel(
        { ...base, voucherMaxBytes: 4 },
        {
          ctx: adminCtx(),
          channelId: 7,
          amount: '1',
          voucherDataUrl: `data:image/png;base64,${Buffer.alloc(64).toString('base64')}`,
          operationId: 'op-bad-v',
        },
      ),
    ).rejects.toMatchObject({ code: 'control_plane.voucher_too_large' });
  });
});

describe('调账（守卫 = 调后非负）', () => {
  it('调正/调负生效并落流水；调到为负 → insufficient_budget（quota_exhausted）', async () => {
    const { base, channels } = setup();
    const up = await adjustChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '10',
      operationId: 'adj-1',
    });
    expect(up.balanceAfter).toBe('110');
    const down = await adjustChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '-20',
      operationId: 'adj-2',
    });
    expect(down.balanceAfter).toBe('90');
    expect(channels.recharges.filter((r) => r.type === 'adjust')).toHaveLength(2);
    await expect(
      adjustChannel(base, { ctx: adminCtx(), channelId: 7, amount: '-1000', operationId: 'adj-3' }),
    ).rejects.toMatchObject({ code: 'control_plane.insufficient_budget' });
    // 守卫失败的操作占位被回滚——同键可重试（内存替身无回滚语义，换键验证业务拒绝即可）
    expect(channels.rows.get(7)!.upstreamBudget).toBe('90');
  });

  it('调账非法金额（零值/垃圾形状）→ invalid_channel_input', async () => {
    const { base } = setup();
    await expect(
      adjustChannel(base, { ctx: adminCtx(), channelId: 7, amount: '0', operationId: 'adj-zero' }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_channel_input' });
    await expect(
      adjustChannel(base, {
        ctx: adminCtx(),
        channelId: 7,
        amount: '1e999',
        operationId: 'adj-exp',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.invalid_channel_input' });
  });

  it('调账渠道不存在 → channel_not_found（0 行二义消解）', async () => {
    const { base } = setup();
    await expect(
      adjustChannel(base, {
        ctx: adminCtx(),
        channelId: 999,
        amount: '1',
        operationId: 'adj-miss',
      }),
    ).rejects.toMatchObject({ code: 'control_plane.channel_not_found' });
  });
});

describe('流水列表', () => {
  it('按渠道与类型过滤；余额快照与操作人回显', async () => {
    const { base } = setup();
    await rechargeChannel(base, { ctx: adminCtx(), channelId: 7, amount: '5', operationId: 'l-1' });
    await adjustChannel(base, { ctx: adminCtx(), channelId: 7, amount: '-2', operationId: 'l-2' });
    const all = await listRecharges(base, { sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    const onlyAdjust = await listRecharges(base, {
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      type: 'adjust',
    });
    expect(onlyAdjust.rows[0]).toMatchObject({ type: 'adjust', balanceAfter: '103', adminId: 1 });
  });
});

describe('审计 best-effort 契约（B3 语义保持）', () => {
  it('审计出口故障不反噬已提交的业务操作', async () => {
    const { base, audit } = setup();
    audit.fail.on = true;
    const result = await rechargeChannel(base, {
      ctx: adminCtx(),
      channelId: 7,
      amount: '3',
      operationId: 'op-audit-down',
    });
    expect(result.ok).toBe(true);
    expect(result.balanceAfter).toBe('103');
  });
});
