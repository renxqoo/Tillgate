/**
 * 拉新参数与关系管理(MIGRATION §1.5-5..6):settings 读写/审计、关系列表/封禁恢复。
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../src/testing/harness.js';

describe('marketing settings', () => {
  it('缺行兜底全 0(v1 getSettings 语义)', async () => {
    const h = createTestHarness();
    const s = await h.api.getMarketingSettings();
    expect(s).toMatchObject({
      signupGiftAmount: '0',
      referralSignupBonus: '0',
      referralCommissionRate: '0',
    });
  });

  it('写入:部分字段 upsert 保留其余;updatedBy 记录;审计同事务', async () => {
    const h = createTestHarness();
    await h.api.updateMarketingSettings({ patch: { signupGiftAmount: '1.5' }, adminId: 9 });
    const first = await h.api.getMarketingSettings();
    expect(first.signupGiftAmount).toBe('1.5');
    expect(first.referralSignupBonus).toBe('0'); // 未动字段保留
    expect(first.updatedBy).toBe(9);

    await h.api.updateMarketingSettings({ patch: { referralCommissionRate: '0.2' }, adminId: 8 });
    const second = await h.api.getMarketingSettings();
    expect(second.signupGiftAmount).toBe('1.5');
    expect(second.referralCommissionRate).toBe('0.2');

    expect(h.audit.actions).toHaveLength(2);
    expect(h.audit.actions[0]).toMatchObject({
      action: 'marketing.settings.update',
      targetType: 'marketing_settings',
      targetId: '1',
      adminId: 9,
    });
  });

  it('域校验:负数/比例>1/科学计数法 → marketing_settings_invalid(带字段名)', async () => {
    const h = createTestHarness();
    await expect(
      h.api.updateMarketingSettings({ patch: { signupGiftAmount: '-1' }, adminId: 1 }),
    ).rejects.toMatchObject({ code: 'accounts.marketing_settings_invalid' });
    await expect(
      h.api.updateMarketingSettings({ patch: { referralCommissionRate: '1.5' }, adminId: 1 }),
    ).rejects.toMatchObject({ code: 'accounts.marketing_settings_invalid' });
    await expect(
      h.api.updateMarketingSettings({ patch: { referralSignupBonus: '1e3' }, adminId: 1 }),
    ).rejects.toMatchObject({ code: 'accounts.marketing_settings_invalid' });
  });
});

function relations() {
  const h = createTestHarness();
  h.store.seed.user({ id: 1, email: 'inviter@x.io', displayName: '邀请人' });
  h.store.seed.user({ id: 2, email: 'invitee@x.io', displayName: '被邀人' });
  h.store.seed.referral({ id: 30, inviterUserId: 1, inviteeUserId: 2 });
  return h;
}

describe('referral relations(管理面)', () => {
  it('列表:双方账号投影;q 命中任一侧 email/displayName', async () => {
    const h = relations();
    const all = await h.api.listReferralRelations({});
    expect(all.total).toBe(1);
    expect(all.rows[0]).toMatchObject({
      inviterEmail: 'inviter@x.io',
      inviteeDisplayName: '被邀人',
      status: 0,
    });
    const byQ = await h.api.listReferralRelations({ q: '邀请人' });
    expect(byQ.total).toBe(1);
    const miss = await h.api.listReferralRelations({ q: 'nobody' });
    expect(miss.total).toBe(0);
  });

  it('封禁/恢复(0|1);非法状态拒绝;不存在 → relation_not_found;审计', async () => {
    const h = relations();
    const banned = await h.api.setReferralRelationStatus({ relationId: 30, status: 1, adminId: 4 });
    expect(banned.status).toBe(1);
    const restored = await h.api.setReferralRelationStatus({
      relationId: 30,
      status: 0,
      adminId: 4,
    });
    expect(restored.status).toBe(0);
    await expect(
      h.api.setReferralRelationStatus({ relationId: 30, status: 5, adminId: 4 }),
    ).rejects.toMatchObject({ code: 'accounts.relation_status_invalid' });
    await expect(
      h.api.setReferralRelationStatus({ relationId: 999, status: 1, adminId: 4 }),
    ).rejects.toMatchObject({ code: 'accounts.relation_not_found' });
    expect(h.audit.actions.at(-1)).toMatchObject({
      action: 'referral.relation.update',
      targetType: 'referral_relation',
      targetId: '30',
    });
  });
});
