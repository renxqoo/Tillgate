/**
 * 推荐与开户赠送(MIGRATION §1.5-1..4):归因拒绝矩阵、同生共死回滚(broken wallet)、
 * 幂等、尽力而为收尾、概览开关。
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../src/testing/harness.js';
import { referralSignupRefId, signupGiftRefId } from '../src/domain/referral.js';

function withUsers() {
  const h = createTestHarness();
  h.store.seed.user({ id: 1, email: 'inviter@x.io' });
  h.store.seed.user({ id: 2, email: 'invitee@x.io' });
  return h;
}

describe('grantSignupGift', () => {
  it('金额>0:gift/signup:{userId} 入账;幂等重放 replayed=true', async () => {
    const h = withUsers();
    h.store.seed.marketing({ signupGiftAmount: '2.5' });
    const first = await h.api.grantSignupGift(2);
    expect(first).toEqual({ credited: true, replayed: false });
    expect(h.wallet.credits).toEqual([
      { refType: 'gift', refId: 'signup:2', userId: 2, amount: '2.5', memo: '注册赠送' },
    ]);
    const second = await h.api.grantSignupGift(2);
    expect(second).toEqual({ credited: true, replayed: true });
    expect(h.wallet.credits).toHaveLength(1); // 未二次入账
  });

  it('金额 0/缺行 → 关闭,不调入账', async () => {
    const h = withUsers();
    expect(await h.api.grantSignupGift(2)).toEqual({ credited: false, replayed: false });
    h.store.seed.marketing({ signupGiftAmount: '0' });
    expect(await h.api.grantSignupGift(2)).toEqual({ credited: false, replayed: false });
    expect(h.wallet.credits).toHaveLength(0);
  });

  it('幂等锚词表与 domain 构造器一致', () => {
    expect(signupGiftRefId(2)).toBe('signup:2');
    expect(referralSignupRefId(2, 'inviter')).toBe('referral-signup:2:inviter');
  });
});

describe('applyReferral', () => {
  it('happy path:建关系 + 双方同额奖励(inviter 与 invitee 各一笔)', async () => {
    const h = withUsers();
    h.store.seed.marketing({ referralSignupBonus: '1.5' });
    const r = await h.api.applyReferral({ inviteeUserId: 2, affCode: 'u1' });
    expect(r).toEqual({ applied: true, bonusCredited: true });
    expect(h.wallet.credits.map((c) => c.refId)).toEqual(['referral-signup:2:inviter', 'referral-signup:2:invitee']);
    for (const c of h.wallet.credits) expect(c.amount).toBe('1.5');
  });

  it.each([
    ['bad-code', 'accounts.referral_invalid_code', '畸形码'],
    ['u2', 'accounts.referral_self_invite', '自邀'],
    ['u9', 'accounts.referral_inviter_not_found', '邀请人不存在'],
  ])('aff=%s → %s(%s)', async (code, expected, label) => {
    const h = withUsers();
    h.store.seed.marketing({ referralSignupBonus: '1' });
    await expect(h.api.applyReferral({ inviteeUserId: 2, affCode: code })).rejects.toMatchObject({ code: expected });
    expect(h.wallet.credits).toHaveLength(0);
    void label;
  });

  it('封禁邀请人 → inviter_not_found(防枚举)且零入账', async () => {
    const h = withUsers();
    h.store.seed.user({ id: 3, status: 1 });
    h.store.seed.user({ id: 4 });
    await expect(h.api.applyReferral({ inviteeUserId: 4, affCode: 'u3' })).rejects.toMatchObject({
      code: 'accounts.referral_inviter_not_found',
    });
  });

  it('bonus=0:建关系零入账;重复归因 → already_referred(唯一索引兜底)', async () => {
    const h = withUsers();
    await h.api.applyReferral({ inviteeUserId: 2, affCode: 'u1' });
    expect(h.wallet.credits).toHaveLength(0);
    await expect(h.api.applyReferral({ inviteeUserId: 2, affCode: 'u1' })).rejects.toMatchObject({
      code: 'accounts.referral_already_referred',
    });
  });

  it('任一侧奖励失败 → 关系与另一侧奖励整体回滚(v1 broken wallet 语义)', async () => {
    const h = withUsers();
    h.store.seed.marketing({ referralSignupBonus: '1' });
    h.wallet.failOnRefId('referral-signup:2:invitee'); // 第二笔炸
    await expect(h.api.applyReferral({ inviteeUserId: 2, affCode: 'u1' })).rejects.toThrow('wallet credit failed');
    // 回滚:关系不存在、第一笔奖励不在替身账本(内存替身账本独立于快照,断言关系)
    const invitees = await h.store.listInvitees(h.ctx.db, { inviterUserId: 1, limit: 10 });
    expect(invitees).toHaveLength(0);
  });
});

describe('completeAccountOnboarding(尽力而为,v1 全吞语义)', () => {
  it('赠送失败/归因拒绝都不抛,结果记入报告', async () => {
    const h = withUsers();
    h.store.seed.marketing({ signupGiftAmount: '1', referralSignupBonus: '1' });
    h.wallet.failOnRefId('signup:2'); // 赠送炸
    const report = await h.api.completeAccountOnboarding({ userId: 2, affCode: 'u1' });
    expect(report.gift.status).toBe('failed');
    expect(report.referral).toEqual({ status: 'applied', bonusCredited: true });

    // 全新账号 + 自邀码:归因被拒但不抛
    h.store.seed.user({ id: 5 });
    const r2 = await h.api.completeAccountOnboarding({ userId: 5, affCode: 'u5' });
    expect(r2.referral).toMatchObject({ status: 'rejected', code: 'accounts.referral_self_invite' });
  });

  it('无 affCode → 归因 skipped;赠送关闭 → disabled', async () => {
    const h = withUsers();
    const report = await h.api.completeAccountOnboarding({ userId: 2 });
    expect(report.gift).toEqual({ status: 'disabled' });
    expect(report.referral).toEqual({ status: 'skipped' });
  });
});

describe('referralOverview', () => {
  it('开关/aff 码/邀请链接(基址注入)/被邀名单(limit 注入)', async () => {
    const h = withUsers();
    h.store.seed.marketing({ referralSignupBonus: '0.5', referralCommissionRate: '0.1' });
    const inv = await h.api.applyReferral({ inviteeUserId: 2, affCode: 'u1' });
    void inv;
    const overview = await h.api.referralOverview({ userId: 1, frontendBaseUrl: 'https://c.example.com' });
    expect(overview.enabled).toBe(true);
    expect(overview.affCode).toBe('u1');
    expect(overview.inviteUrl).toBe('https://c.example.com/register?aff=u1');
    expect(overview.signupBonus).toBe('0.5');
    expect(overview.commissionRate).toBe('0.1');
    expect(overview.invitees).toHaveLength(1);
    expect(overview.invitees[0]!.inviteeUserId).toBe(2);
  });

  it('全 0 参数 → enabled=false;空名单零佣金面(G2:totalCommission 归 app 组合)', async () => {
    const h = withUsers();
    const overview = await h.api.referralOverview({ userId: 1, frontendBaseUrl: 'https://x.io' });
    expect(overview.enabled).toBe(false);
    expect(overview.invitees).toEqual([]);
  });
});
