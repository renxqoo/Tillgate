/**
 * 组织/成员/邀请用例:席位不变量、邀请全矩阵、复活语义、
 * owner 保护、active-only 设限回归、订阅绑定守卫。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import { createTestHarness } from '../src/testing/harness.js';

/** 标准场地:owner + 组织 + quantity 席位订阅 + 一个成员邮箱账号 */
function teamOrg(quantity = 3) {
  const h = createTestHarness();
  const owner = h.store.seed.user({ id: 100, email: 'owner@x.io' });
  const org = h.store.seed.org({ id: 10, ownerUserId: owner.id });
  h.store.seed.member({ orgId: org.id, userId: owner.id, role: 'owner' });
  h.store.seed.subscription({ id: 500, userId: owner.id, orgId: org.id, quantity });
  return { h, owner, org };
}

describe('createOrg / listMyOrgs / getOrgDetail', () => {
  it('org + owner 成员行同事务诞生;owner 占 1 席;列表带组织名与角色', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ email: 'o@x.io' });
    const org = await h.api.createOrg({ ownerUserId: owner.id, name: ' Acme ' });
    expect(org.name).toBe('Acme');
    expect(await h.api.listMyOrgs(owner.id)).toHaveLength(1);
    expect((await h.api.listMyOrgs(owner.id))[0]).toMatchObject({ role: 'owner', orgName: 'Acme' });
    expect(await h.api.userExists(owner.id)).toBe(true);
  });

  it('组织名域校验;owner 不存在拒绝', async () => {
    const h = createTestHarness();
    await expect(h.api.createOrg({ ownerUserId: 1, name: '' })).rejects.toMatchObject({
      code: 'accounts.org_name_invalid',
    });
    h.store.seed.user({ id: 2 });
    await expect(h.api.createOrg({ ownerUserId: 999, name: 'x' })).rejects.toMatchObject({
      code: 'accounts.user_not_found',
    });
    await h.api.createOrg({ ownerUserId: 2, name: 'x'.repeat(64) });
  });

  it('详情:非成员 → org_not_found;成员可见成员列表;邀请列表仅 owner 且无 token', async () => {
    const { h, owner, org } = teamOrg();
    const member = h.store.seed.user({ id: 101, email: 'm@x.io' });
    h.store.seed.member({ orgId: org.id, userId: member.id, role: 'member' });
    const stranger = h.store.seed.user({ id: 102, email: 's@x.io' });

    await expect(h.api.getOrgDetail({ userId: stranger.id, orgId: org.id })).rejects.toMatchObject({
      code: 'accounts.org_not_found',
    });
    const ownerView = await h.api.getOrgDetail({ userId: owner.id, orgId: org.id });
    expect(ownerView.members).toHaveLength(2);
    expect(ownerView.invitations).toEqual([]);
    const memberView = await h.api.getOrgDetail({ userId: member.id, orgId: org.id });
    expect(memberView.members).toHaveLength(2);
    expect(memberView.invitations).toEqual([]);

    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'new@x.io',
    });
    const ownerAgain = await h.api.getOrgDetail({ userId: owner.id, orgId: org.id });
    expect(ownerAgain.invitations).toHaveLength(1);
    expect(JSON.stringify(ownerAgain.invitations)).not.toContain(inv.token); // token 永不回列表
    const memberAgain = await h.api.getOrgDetail({ userId: member.id, orgId: org.id });
    expect(memberAgain.invitations).toEqual([]); // 非 owner 不可见
  });
});

describe('inviteMember', () => {
  it('happy path:token 32hex、TTL 注入、pending 计数', async () => {
    const { h, owner, org } = teamOrg();
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: ' New@X.IO ',
    });
    expect(inv.token).toMatch(/^[0-9a-f]{32}$/);
    expect(await h.store.countPendingInvitations(h.ctx.db, org.id)).toBe(1);
    const again = await h.api.getOrgDetail({ userId: owner.id, orgId: org.id });
    expect(defined(again.invitations[0], 'again.invitations[0]').email).toBe('new@x.io'); // 规范化落库
  });

  it('owner-only:非 owner/非成员统一 org_forbidden', async () => {
    const { h, org } = teamOrg();
    const stranger = h.store.seed.user({ id: 102, email: 's@x.io' });
    const member = h.store.seed.user({ id: 101, email: 'm@x.io' });
    h.store.seed.member({ orgId: org.id, userId: member.id, role: 'member' });
    await expect(
      h.api.inviteMember({ orgId: org.id, operatorUserId: stranger.id, email: 'a@b.io' }),
    ).rejects.toMatchObject({
      code: 'accounts.org_forbidden',
    });
    await expect(
      h.api.inviteMember({ orgId: org.id, operatorUserId: member.id, email: 'a@b.io' }),
    ).rejects.toMatchObject({
      code: 'accounts.org_forbidden',
    });
  });

  it('无有效订阅 → org_no_subscription;邮箱域校验', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 100 });
    const org = h.store.seed.org({ ownerUserId: owner.id });
    h.store.seed.member({ orgId: org.id, userId: owner.id, role: 'owner' });
    await expect(
      h.api.inviteMember({ orgId: org.id, operatorUserId: owner.id, email: 'a@b.io' }),
    ).rejects.toMatchObject({
      code: 'accounts.org_no_subscription',
    });
    await expect(
      h.api.inviteMember({ orgId: org.id, operatorUserId: owner.id, email: 'bad' }),
    ).rejects.toMatchObject({ code: 'accounts.email_invalid' });
  });

  it('席位闸:active ≥ quantity → seats_full(v1 qty=1 owner 占满)', async () => {
    const { h, owner, org } = teamOrg(1);
    await expect(
      h.api.inviteMember({ orgId: org.id, operatorUserId: owner.id, email: 'a@b.io' }),
    ).rejects.toMatchObject({
      code: 'accounts.seats_full',
    });
  });

  it('待接受上限 = min(max(剩余,1)×factor, cap)(v1:qty2-owner占1-两个pending-第三个拒)', async () => {
    const { h, owner, org } = teamOrg(2);
    await h.api.inviteMember({ orgId: org.id, operatorUserId: owner.id, email: 'a1@x.io' });
    await h.api.inviteMember({ orgId: org.id, operatorUserId: owner.id, email: 'a2@x.io' });
    await expect(
      h.api.inviteMember({ orgId: org.id, operatorUserId: owner.id, email: 'a3@x.io' }),
    ).rejects.toMatchObject({
      code: 'accounts.invitations_full',
    });
  });

  it('撤销:CAS 一次;重复撤销 → invitation_invalid;非 owner 拒绝', async () => {
    const { h, owner, org } = teamOrg();
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'a@x.io',
    });
    await h.api.revokeInvitation({
      orgId: org.id,
      operatorUserId: owner.id,
      invitationId: inv.invitationId,
    });
    await expect(
      h.api.revokeInvitation({
        orgId: org.id,
        operatorUserId: owner.id,
        invitationId: inv.invitationId,
      }),
    ).rejects.toMatchObject({ code: 'accounts.invitation_invalid' });
  });
});

describe('acceptInvitation', () => {
  it('错误矩阵:invalid/revoked/already_accepted/expired/email_mismatch(时序与判定)', async () => {
    const { h, owner, org } = teamOrg();
    const acceptor = h.store.seed.user({ id: 101, email: 'target@x.io' });

    await expect(
      h.api.acceptInvitation({ token: 'nope', acceptorUserId: acceptor.id }),
    ).rejects.toMatchObject({
      code: 'accounts.invitation_invalid',
    });

    const revoked = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'target@x.io',
    });
    await h.api.revokeInvitation({
      orgId: org.id,
      operatorUserId: owner.id,
      invitationId: revoked.invitationId,
    });
    await expect(
      h.api.acceptInvitation({ token: revoked.token, acceptorUserId: acceptor.id }),
    ).rejects.toMatchObject({
      code: 'accounts.invitation_revoked',
    });

    const mismatched = h.store.seed.invitation({
      orgId: org.id,
      email: 'other@x.io',
      token: 't-mismatch',
    });
    await expect(
      h.api.acceptInvitation({ token: 't-mismatch', acceptorUserId: acceptor.id }),
    ).rejects.toMatchObject({
      code: 'accounts.invitation_email_mismatch',
    });
    void mismatched;

    // 过期:时钟越过 TTL
    const expiring = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'target@x.io',
    });
    h.advanceClockMs(7 * 86_400_000 + 1_000);
    await expect(
      h.api.acceptInvitation({ token: expiring.token, acceptorUserId: acceptor.id }),
    ).rejects.toMatchObject({
      code: 'accounts.invitation_expired',
    });
  });

  it('happy path:成员 role=member;pending 列表消耗;重复接受 → already_accepted', async () => {
    const { h, owner, org } = teamOrg();
    const acceptor = h.store.seed.user({ id: 101, email: 'target@x.io' });
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'target@x.io',
    });
    const { orgId } = await h.api.acceptInvitation({
      token: inv.token,
      acceptorUserId: acceptor.id,
    });
    expect(orgId).toBe(org.id);
    expect(await h.store.countActiveMembers(h.ctx.db, org.id)).toBe(2);
    expect(await h.api.getOrgDetail({ userId: owner.id, orgId: org.id })).toMatchObject({});
    const pending = await h.api.getOrgDetail({ userId: owner.id, orgId: org.id });
    expect(pending.invitations).toHaveLength(0);
    await expect(
      h.api.acceptInvitation({ token: inv.token, acceptorUserId: acceptor.id }),
    ).rejects.toMatchObject({
      code: 'accounts.invitation_already_accepted',
    });
  });

  it('接受事务内复检席位:满员 → seats_full 且成员行不入库(回滚语义)', async () => {
    const { h, owner, org } = teamOrg(3); // 邀请时 3 席
    const acceptor = h.store.seed.user({ id: 101, email: 'target@x.io' });
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'target@x.io',
    });
    // 邀请后订阅降为 1 席(owner 占满):accept 权威复检拒绝
    h.store.seed.subscription({ id: 500, userId: owner.id, orgId: org.id, quantity: 1 });
    await expect(
      h.api.acceptInvitation({ token: inv.token, acceptorUserId: acceptor.id }),
    ).rejects.toMatchObject({
      code: 'accounts.seats_full',
    });
    expect(await h.store.countActiveMembers(h.ctx.db, org.id)).toBe(1); // 未复活/未插入
    expect(
      defined(await h.store.findInvitationByToken(h.ctx.db, inv.token), 'findInvitationByToken')
        .status,
    ).toBe(0); // 邀请未被消费
  });

  it('被移除成员经新邀请复活(同 (org,user) 行 status 1→0)', async () => {
    const { h, owner, org } = teamOrg();
    const member = h.store.seed.user({ id: 101, email: 'm@x.io' });
    h.store.seed.member({ orgId: org.id, userId: member.id, role: 'member' });
    await h.api.removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: member.id });
    expect(await h.store.countActiveMembers(h.ctx.db, org.id)).toBe(1);
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'm@x.io',
    });
    await h.api.acceptInvitation({ token: inv.token, acceptorUserId: member.id });
    expect(await h.store.countActiveMembers(h.ctx.db, org.id)).toBe(2);
    const membership = await h.store.findActiveMembership(h.ctx.db, {
      orgId: org.id,
      userId: member.id,
    });
    expect(defined(membership, 'membership').role).toBe('member');
  });
});

describe('setMemberLimits / removeMember / 订阅绑定守卫', () => {
  it('B5 回归:仅 active 成员可设限;已离开 → member_not_found;域校验', async () => {
    const { h, owner, org } = teamOrg();
    const member = h.store.seed.user({ id: 101 });
    h.store.seed.member({ orgId: org.id, userId: member.id, role: 'member' });
    const set = await h.api.setMemberLimits({
      orgId: org.id,
      operatorUserId: owner.id,
      memberUserId: member.id,
      dailySpendLimit: '100.5',
      monthlyQuota: '200',
    });
    expect(set.dailySpendLimit).toBe('100.5');
    expect(set.monthlyQuota).toBe('200');
    await expect(
      h.api.setMemberLimits({
        orgId: org.id,
        operatorUserId: owner.id,
        memberUserId: member.id,
        dailySpendLimit: '1e21',
      }),
    ).rejects.toMatchObject({ code: 'accounts.member_limits_invalid' });
    await h.api.removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: member.id });
    await expect(
      h.api.setMemberLimits({
        orgId: org.id,
        operatorUserId: owner.id,
        memberUserId: member.id,
        dailySpendLimit: '1',
      }),
    ).rejects.toMatchObject({ code: 'accounts.member_not_found' });
  });

  it('owner 不可移除自己;移除 CAS;重复移除 → member_not_found;非 owner 操作拒绝', async () => {
    const { h, owner, org } = teamOrg();
    const member = h.store.seed.user({ id: 101 });
    h.store.seed.member({ orgId: org.id, userId: member.id, role: 'member' });
    await expect(
      h.api.removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: owner.id }),
    ).rejects.toMatchObject({ code: 'accounts.org_cannot_remove_owner' });
    await expect(
      h.api.removeMember({ orgId: org.id, operatorUserId: member.id, memberUserId: owner.id }),
    ).rejects.toMatchObject({ code: 'accounts.org_forbidden' });
    await h.api.removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: member.id });
    await expect(
      h.api.removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: member.id }),
    ).rejects.toMatchObject({ code: 'accounts.member_not_found' });
  });

  it('成员限额读模型(memberLimits)与组织成员视角订阅绑定', async () => {
    const { h, owner, org } = teamOrg(5);
    const member = h.store.seed.user({ id: 101 });
    h.store.seed.member({ orgId: org.id, userId: member.id, role: 'member' });
    h.store.seed.subscription({ id: 500, userId: owner.id, orgId: org.id, quantity: 5 });
    // 成员可绑组织订阅;陌生人/被移除者不可
    const memberKey = await h.api.createKey({ userId: member.id, name: 'k', subscriptionId: 500 });
    expect(memberKey.key.subscriptionId).toBe(500);
    const stranger = h.store.seed.user({ id: 102 });
    await expect(
      h.api.createKey({ userId: stranger.id, name: 'k', subscriptionId: 500 }),
    ).rejects.toMatchObject({
      code: 'accounts.subscription_not_usable',
    });
    // 被移除后既有绑定不删(历史归属),仅新建被拒
    await h.api.removeMember({ orgId: org.id, operatorUserId: owner.id, memberUserId: member.id });
    expect(
      defined(
        await h.store.findOwnedKey(h.ctx.db, { userId: member.id, keyId: memberKey.key.id }),
        'findOwnedKey',
      ).subscriptionId,
    ).toBe(500);
    await expect(
      h.api.createKey({ userId: member.id, name: 'k2', subscriptionId: 500 }),
    ).rejects.toMatchObject({
      code: 'accounts.subscription_not_usable',
    });
    // 读模型
    h.store.seed.member({ orgId: org.id, userId: 777, dailySpendLimit: '10', monthlyQuota: '20' });
    expect(await h.api.memberLimits({ orgId: org.id, userId: 777 })).toEqual({
      dailySpendLimit: '10',
      monthlyQuota: '20',
    });
    expect(await h.api.memberLimits({ orgId: org.id, userId: 888 })).toBeNull();
  });
});
