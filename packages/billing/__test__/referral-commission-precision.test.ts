/**
 * 红测（审计问题 #5：邀请佣金因小数位超限被永久拒绝入账）：
 * usage_logs.amount 是 numeric(38,18)，SQL sum 合计最多 18 位小数；
 * referral-commission 用 `Decimal(合计) × rate` 全精度不取整、toString() 直传
 * wallet.credit。合计 18 位小数 × 两位小数费率 → 乘积可达 20 位小数，
 * parsePositiveAmount 落库正则（≤18 位小数）判 out_of_scale 拒绝——
 * 该行佣金每 tick 失败、幂等键永远建不出来，该邀请人该日佣金永久丢失。
 * 契约：佣金入账金额必须满足全包唯一金额契约（可落库）。本文件当前为红，
 * 修复（佣金乘积显式取整策略）后转绿。
 */
import { describe, expect, it } from 'vitest';
import { createReferralCommissionUseCase } from '../src/application/referral-commission.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import type { CommissionStatsStore } from '../src/ports/commission-stats.js';

const DAY_FROM = new Date('2026-08-22T00:00:00Z');

/** 单窗口 stats 替身：usage_logs 聚合 sum 语义上限 18 位小数 */
function statsOf(total: string): CommissionStatsStore {
  return {
    async sumInviteeSpendByInviter(input) {
      if (input.from.getTime() === DAY_FROM.getTime()) {
        return [{ inviterId: 201, total }];
      }
      return [];
    },
  };
}

function harness(total: string, rate: string) {
  const wallet = createWalletApi({
    store: createInMemoryWalletStore().store,
    guards: {
      refTypes: ['referral'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const errors: Array<{ error: unknown; context: string }> = [];
  const run = createReferralCommissionUseCase({
    stats: statsOf(total),
    wallet,
    rate: async () => rate,
    refIdOf: (inviterId, dayKey) => `referral-commission:${inviterId}:${dayKey}`,
    backfillDays: 1,
    clock: () => new Date('2026-08-23T10:30:00Z'),
    onError: (error, context) => errors.push({ error, context }),
  });
  return { run, errors };
}

describe('邀请佣金精度 × 金额契约', () => {
  it('18 位小数合计 × 两位小数费率必须成功入账（当前 out_of_scale 永久拒绝）', async () => {
    // 1.000000000000000001 × 0.15 = 0.15000000000000000015（20 位小数 > 落库上限 18 位）
    const { run, errors } = harness('1.000000000000000001', '0.15');
    const result = await run();
    expect(result.credited).toBe(1);
    expect(errors).toEqual([]);
  });

  it('对照：低精度合计照常入账（排除替身/装配噪音）', async () => {
    const { run, errors } = harness('12.5', '0.1');
    const result = await run();
    expect(result.credited).toBe(1);
    expect(errors).toEqual([]);
  });
});
