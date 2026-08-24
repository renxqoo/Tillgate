/**
 * 返利流水管理读侧（U8/admin-api P3 消费的 billing 接缝）契约测试：
 * 三类投影（refType + refId 前缀）互不串扰、id 倒序、limit/offset 分页、total 计数、
 * 同 refType 异前缀不误收（commission ↔ referral_signup 同 refType='referral' 的
 * 前缀边界——v1 marketing.repo listPayouts 行为规格）。
 */
import { describe, expect, it } from 'vitest';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { defined } from './defined.js';

const GUARDS = {
  refTypes: ['billing', 'topup', 'admin', 'gift', 'referral'],
  currencies: ['CNY', 'USD'],
  internalAccounts: ['outside', 'platform_revenue'],
} as const;

function harness() {
  const memory = createInMemoryWalletStore();
  const api = createWalletApi({ store: memory.store, guards: { ...GUARDS }, currency: 'CNY' });
  return { memory, api };
}

async function seeded() {
  const { api } = harness();
  const user = 4242;
  // 各类两笔 + 同 refType 干扰项:同额无关紧要,只看投影与排序
  await api.credit({
    userId: user,
    amount: '1',
    refType: 'referral',
    refId: 'referral-commission:7:20260823',
  });
  await api.credit({
    userId: user,
    amount: '1',
    refType: 'referral',
    refId: 'referral-commission:7:20260824',
  });
  await api.credit({
    userId: user,
    amount: '1',
    refType: 'referral',
    refId: 'referral-signup:8:inviter',
  });
  await api.credit({
    userId: user,
    amount: '1',
    refType: 'referral',
    refId: 'referral-signup:9:invitee',
  });
  await api.credit({ userId: user, amount: '1', refType: 'gift', refId: 'signup:8' });
  await api.credit({ userId: user, amount: '1', refType: 'gift', refId: 'signup:9' });
  await api.credit({ userId: user, amount: '1', refType: 'referral', refId: 'other-thing:1' });
  await api.credit({ userId: user, amount: '1', refType: 'gift', refId: 'campaign:1' });
  await api.credit({ userId: user, amount: '1', refType: 'topup', refId: 'signup-lookalike:1' });
  return api;
}

describe('referralPayouts（返利流水管理读侧）', () => {
  it('commission:仅佣金前缀,referral_signup 同 refType 不误收;id 倒序', async () => {
    const api = await seeded();
    const page = await api.referralPayouts({ kind: 'commission', limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.refId)).toEqual([
      'referral-commission:7:20260824',
      'referral-commission:7:20260823',
    ]);
    expect(page.rows[0]).toMatchObject({ refType: 'referral', kind: 'credit', memo: null });
    expect(defined(page.rows[0]).createdAt instanceof Date).toBe(true);
  });

  it('referral_signup 与 gift 各自投影封闭（干扰前缀/异 refType 零误收）', async () => {
    const api = await seeded();
    const signup = await api.referralPayouts({ kind: 'referral_signup', limit: 10, offset: 0 });
    expect(signup.total).toBe(2);
    expect(signup.rows.every((r) => r.refId.startsWith('referral-signup:'))).toBe(true);
    const gift = await api.referralPayouts({ kind: 'gift', limit: 10, offset: 0 });
    expect(gift.total).toBe(2);
    expect(gift.rows.every((r) => r.refId.startsWith('signup:'))).toBe(true);
  });

  it('limit/offset 分页:首页一条 + 次页一条,total 恒全量', async () => {
    const api = await seeded();
    const first = await api.referralPayouts({ kind: 'gift', limit: 1, offset: 0 });
    const second = await api.referralPayouts({ kind: 'gift', limit: 1, offset: 1 });
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(defined(first.rows[0]).id).toBeGreaterThan(defined(second.rows[0]).id);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    // 越界 offset 空页不抛
    const beyond = await api.referralPayouts({ kind: 'gift', limit: 1, offset: 9 });
    expect(beyond.rows).toEqual([]);
  });
});
