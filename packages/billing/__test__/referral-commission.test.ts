/**
 * 佣金日结用例单测（v1 apps/worker __tests__/referral.test.ts 语义对位；
 * 内存 wallet + stub stats——postgres 聚合 SQL 由 real 门覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { createReferralCommissionUseCase } from '../src/application/referral-commission.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import type { CommissionStatsStore } from '../src/ports/commission-stats.js';

function stubStats(
  windows: Array<{ from: Date; to: Date; rows: Array<{ inviterId: number; total: string }> }>,
): CommissionStatsStore & { calls: Array<{ from: Date; to: Date }> } {
  const calls: Array<{ from: Date; to: Date }> = [];
  return {
    calls,
    async sumInviteeSpendByInviter(input) {
      calls.push({ from: input.from, to: input.to });
      const hit = windows.find(
        (w) => w.from.getTime() === input.from.getTime() && w.to.getTime() === input.to.getTime(),
      );
      return hit?.rows ?? [];
    },
  };
}

function harness(options?: {
  stats?: CommissionStatsStore;
  rate?: () => Promise<string>;
  clock?: () => Date;
  refIds?: Map<string, string>;
  onError?: (error: unknown, context: string) => void;
}) {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['referral'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const refIds = options?.refIds ?? new Map<string, string>();
  const errors: Array<{ error: unknown; context: string }> = [];
  const run = createReferralCommissionUseCase({
    stats:
      options?.stats ??
      stubStats([
        {
          from: new Date('2026-08-22T00:00:00Z'),
          to: new Date('2026-08-23T00:00:00Z'),
          rows: [
            { inviterId: 101, total: '12.5' },
            { inviterId: 102, total: '0' },
          ],
        },
      ]),
    wallet,
    rate: options?.rate ?? (async () => '0.1'),
    refIdOf: (inviterId, dayKey) => {
      const key = `${inviterId}:${dayKey}`;
      const existing = refIds.get(key);
      if (existing) return existing;
      const id = `referral-commission:${inviterId}:${dayKey}`;
      refIds.set(key, id);
      return id;
    },
    backfillDays: 1,
    clock: options?.clock ?? (() => new Date('2026-08-23T10:30:00Z')),
    onError:
      options?.onError ??
      ((error, context) => {
        errors.push({ error, context });
      }),
  });
  return { wallet, run, refIds, errors };
}

describe('佣金日结（v1 referral.test.ts 对位）', () => {
  it('昨日消费 × 比例入账（全精度）；total=0 跳过', async () => {
    const h = harness();
    const result = await h.run();
    expect(result.credited).toBe(1);
    const accounts = await h.wallet.accounts(101);
    expect(accounts[0]!.balance).toBe('1.25');
    expect(await h.wallet.accounts(102)).toEqual([]);
  });

  it('同日重跑幂等：自然键重放不计 credited，余额不翻倍', async () => {
    const h = harness();
    await h.run();
    const again = await h.run();
    expect(again.credited).toBe(0);
    expect((await h.wallet.accounts(101))[0]!.balance).toBe('1.25');
  });

  it('窗口边界：backfillDays=1 只查昨日 [00:00, 24:00)（今日不计）', async () => {
    const stats = stubStats([]);
    const h = harness({ stats });
    await h.run();
    // clock = 2026-08-23T10:30Z → 昨日窗口 = 08-22T00:00Z ~ 08-23T00:00Z（今日不计）
    expect(stats.calls).toHaveLength(1);
    expect(stats.calls[0]!.from.toISOString()).toBe('2026-08-22T00:00:00.000Z');
    expect(stats.calls[0]!.to.toISOString()).toBe('2026-08-23T00:00:00.000Z');
  });

  it('窗口回补：backfillDays=7 逐日查询（7 个完整 UTC 自然日）', async () => {
    const stats = stubStats([]);
    const h = harness({ stats });
    // 重建 7 日窗口用例（harness 固定 backfillDays=1，此处独立装配）
    const run7 = createReferralCommissionUseCase({
      stats,
      wallet: h.wallet,
      rate: async () => '0.1',
      refIdOf: (inviterId, dayKey) => `referral-commission:${inviterId}:${dayKey}`,
      backfillDays: 7,
      clock: () => new Date('2026-08-23T00:00:00Z'),
      onError: () => undefined,
    });
    await run7();
    expect(stats.calls).toHaveLength(7);
    expect(stats.calls[0]!.from.toISOString()).toBe('2026-08-16T00:00:00.000Z');
    expect(stats.calls.at(-1)!.to.toISOString()).toBe('2026-08-23T00:00:00.000Z');
  });

  it('rate=0：功能关闭——零查询零入账', async () => {
    const stats = stubStats([]);
    const h = harness({ stats, rate: async () => '0' });
    const result = await h.run();
    expect(result.credited).toBe(0);
    expect(stats.calls).toHaveLength(0);
  });

  it('非法 rate：记错误跳过本轮（下一 tick 自愈）', async () => {
    const stats = stubStats([]);
    const h = harness({ stats, rate: async () => 'not-a-number' });
    const result = await h.run();
    expect(result.credited).toBe(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.context).toContain('rate');
    expect(stats.calls).toHaveLength(0);
  });

  it('refId 桥接透传：refIdOf 收到 (inviterId, yyyyMMdd)', async () => {
    const seen: Array<[number, string]> = [];
    const walletMemory = createInMemoryWalletStore();
    const wallet = createWalletApi({
      store: walletMemory.store,
      guards: {
        refTypes: ['referral'],
        currencies: ['CNY'],
        internalAccounts: ['outside', 'platform_revenue'],
      },
      currency: 'CNY',
    });
    const run = createReferralCommissionUseCase({
      stats: stubStats([
        {
          from: new Date('2026-08-22T00:00:00Z'),
          to: new Date('2026-08-23T00:00:00Z'),
          rows: [{ inviterId: 101, total: '10' }],
        },
      ]),
      wallet,
      rate: async () => '0.1',
      refIdOf: (inviterId, dayKey) => {
        seen.push([inviterId, dayKey]);
        return `referral-commission:${inviterId}:${dayKey}`;
      },
      backfillDays: 1,
      clock: () => new Date('2026-08-23T10:30:00Z'),
      onError: () => undefined,
    });
    await run();
    expect(seen).toEqual([[101, '20260822']]);
  });

  it('单行入账异常：跳过继续（其他行照常入账，错误留痕）', async () => {
    let call = 0;
    const wallet = {
      async credit(input: { userId: number }) {
        call += 1;
        if (input.userId === 101) throw new Error('conflict');
        return { replayed: false };
      },
    };
    const errors: unknown[] = [];
    const run = createReferralCommissionUseCase({
      stats: stubStats([
        {
          from: new Date('2026-08-22T00:00:00Z'),
          to: new Date('2026-08-23T00:00:00Z'),
          rows: [
            { inviterId: 101, total: '10' },
            { inviterId: 102, total: '10' },
          ],
        },
      ]),
      wallet,
      rate: async () => '0.1',
      refIdOf: (inviterId, dayKey) => `referral-commission:${inviterId}:${dayKey}`,
      backfillDays: 1,
      clock: () => new Date('2026-08-23T10:30:00Z'),
      onError: (error) => {
        errors.push(error);
      },
    });
    const result = await run();
    expect(result.credited).toBe(1);
    expect(errors).toHaveLength(1);
    expect(call).toBe(2);
  });
});
