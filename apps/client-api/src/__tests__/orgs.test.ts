/**
 * 组织/席位/邀请集成套件（真 PG）：席位守卫 / 邀请上限 / TOCTOU 原子翻转 /
 * 成员 Key 绑组织订阅（归属守卫）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { orgInvitations } from '@ai-gateway/db';
import { createSubscriptionDomain, systemContext } from '@ai-gateway/service';
import { createOrgService } from '../services/org.service.js';
import { createKeysService } from '../services/keys.service.js';
import {
  db,
  newEnterpriseUser,
  newPlan,
  newUser,
  uid,
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-org');
const org = createOrgService({ db });
const keys = createKeysService({ db });
const subscriptionDomain = createSubscriptionDomain({ db, wallet });

interface OrgFixture {
  ownerId: number;
  ownerEmail: string;
  orgId: number;
  subscriptionId: number;
}

/** 企业 owner + 团队套餐（quantity 席）→ 组织（域内自动创建） */
async function newOrgTeam(quantity: number): Promise<OrgFixture> {
  const owner = await newEnterpriseUser();
  await wallet.credit(ctx, { userId: owner.id, amount: '10000', refType: 'gift', refId: uid('fund') });
  const planId = await newPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
  const sub = await subscriptionDomain.purchase(ctx, {
    operationId: uid('op'),
    userId: owner.id,
    planId,
    quantity,
    ensureOrg: true,
  });
  return {
    ownerId: owner.id,
    ownerEmail: owner.email,
    orgId: sub.orgId!,
    subscriptionId: sub.subscriptionId,
  };
}

describe('邀请生命周期', () => {
  it('happy path：邀请（token 一次下发）→ 接受（成员入组）→ 待接受列表消耗', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();

    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    expect(inv.token).toMatch(/^[0-9a-f]{32}$/);
    const detailBefore = await org.orgDetail(ctx, team.ownerId, team.orgId);
    expect(detailBefore.invitations.length).toBe(1);
    expect((detailBefore.invitations[0] as unknown as Record<string, unknown>).token).toBeUndefined();

    const accepted = await org.acceptInvitation(ctx, member.id, inv.token);
    expect(accepted.orgId).toBe(team.orgId);

    const detailAfter = await org.orgDetail(ctx, team.ownerId, team.orgId);
    expect(detailAfter.invitations.length).toBe(0);
    expect(detailAfter.members.find((m) => m.userId === member.id)?.role).toBe('member');
  });

  it('email 不匹配 → 403；重复接受 → 409；无效 token → 404', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    const other = await newUser();
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);

    await expect(org.acceptInvitation(ctx, other.id, inv.token)).rejects.toMatchObject({
      status: 403,
      code: 'invitation_email_mismatch',
    });
    await org.acceptInvitation(ctx, member.id, inv.token);
    await expect(org.acceptInvitation(ctx, member.id, inv.token)).rejects.toMatchObject({
      code: 'invitation_already_accepted',
    });
    await expect(org.acceptInvitation(ctx, member.id, 'f'.repeat(32))).rejects.toMatchObject({
      status: 404,
      code: 'invitation_invalid',
    });
  });

  it('撤销后接受 → 409（TOCTOU：读检查与翻转之间被撤销）', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await org.revokeInvitation(ctx, team.ownerId, team.orgId, inv.invitationId);
    await expect(org.acceptInvitation(ctx, member.id, inv.token)).rejects.toMatchObject({
      code: 'invitation_revoked',
    });
    // 重复撤销 → 404
    await expect(
      org.revokeInvitation(ctx, team.ownerId, team.orgId, inv.invitationId),
    ).rejects.toMatchObject({ status: 404, code: 'invitation_not_found' });
  });

  it('过期邀请 → 410（快路径分型）', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await db
      .update(orgInvitations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(orgInvitations.id, inv.invitationId));
    await expect(org.acceptInvitation(ctx, member.id, inv.token)).rejects.toMatchObject({
      status: 410,
      code: 'invitation_expired',
    });
  });

  it('非 owner：邀请/撤销 403；非成员看详情 404', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    await expect(org.invite(ctx, member.id, team.orgId, member.email)).rejects.toMatchObject({
      status: 403,
      code: 'org_forbidden',
    });
    await expect(org.orgDetail(ctx, member.id, team.orgId)).rejects.toMatchObject({
      status: 404,
      code: 'org_not_found',
    });
  });
});

describe('席位不变量', () => {
  it('席位满：邀请即拒（active ≥ quantity）', async () => {
    // quantity=1：owner 已占满
    const team = await newOrgTeam(1);
    const member = await newUser();
    await expect(org.invite(ctx, team.ownerId, team.orgId, member.email)).rejects.toMatchObject({
      code: 'seats_full',
    });
  });

  it('加席位后可再邀（change quantity↑ 解锁）', async () => {
    const team = await newOrgTeam(1);
    const member = await newUser();
    await expect(org.invite(ctx, team.ownerId, team.orgId, member.email)).rejects.toMatchObject({
      code: 'seats_full',
    });
    const planId = await newPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
    await wallet.credit(ctx, { userId: team.ownerId, amount: '10000', refType: 'gift', refId: uid('fund') });
    await subscriptionDomain.change(ctx, {
      operationId: uid('op'),
      userId: team.ownerId,
      subscriptionId: team.subscriptionId,
      targetPlanId: planId,
      quantity: 2,
    });
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await org.acceptInvitation(ctx, member.id, inv.token);
    const detail = await org.orgDetail(ctx, team.ownerId, team.orgId);
    expect(detail.members.filter((m) => m.status === 0).length).toBe(2);
  });

  it('待接受上限：剩余席位 × 2（防刷邀请行）', async () => {
    const team = await newOrgTeam(2); // owner 占 1，剩 1 → pending 上限 2
    const member = await newUser();
    await org.invite(ctx, team.ownerId, team.orgId, uid('a') + '@example.com');
    await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await expect(
      org.invite(ctx, team.ownerId, team.orgId, uid('b') + '@example.com'),
    ).rejects.toMatchObject({ code: 'invitations_full' });
  });
});

describe('成员管理', () => {
  it('移除成员（owner 不可移除）；被移除者可经新邀请复活', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await org.acceptInvitation(ctx, member.id, inv.token);

    await expect(
      org.removeMember(ctx, team.ownerId, team.orgId, team.ownerId),
    ).rejects.toMatchObject({ code: 'org_cannot_remove_owner' });
    await org.removeMember(ctx, team.ownerId, team.orgId, member.id);

    // 复活：新邀请 → 接受 → 成员行 status 回 0（重入语义）
    const inv2 = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await org.acceptInvitation(ctx, member.id, inv2.token);
    const detail = await org.orgDetail(ctx, team.ownerId, team.orgId);
    expect(detail.members.find((m) => m.userId === member.id)?.status).toBe(0);
  });

  it('成员限额（日限/子配额）owner 可设', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await org.acceptInvitation(ctx, member.id, inv.token);
    await org.patchMember(ctx, team.ownerId, team.orgId, member.id, {
      dailySpendLimit: '10.5',
      monthlyQuota: '200',
    });
    const detail = await org.orgDetail(ctx, team.ownerId, team.orgId);
    const row = detail.members.find((m) => m.userId === member.id)!;
    expect(row.dailySpendLimit!.startsWith('10.5')).toBe(true);
    expect(row.monthlyQuota!.startsWith('200')).toBe(true);
  });
});

describe('成员 Key 绑组织订阅（W1 归属守卫）', () => {
  it('成员可绑组织订阅；陌生人/非成员不可（404 不泄漏存在性）', async () => {
    const team = await newOrgTeam(3);
    const member = await newUser();
    const stranger = await newUser();
    const inv = await org.invite(ctx, team.ownerId, team.orgId, member.email);
    await org.acceptInvitation(ctx, member.id, inv.token);

    // 成员绑组织订阅 → OK
    const bound = await keys.create(ctx, member.id, {
      name: 'team-key',
      subscriptionId: team.subscriptionId,
    });
    expect(bound.subscriptionId).toBe(team.subscriptionId);
    void randomUUID;

    // 陌生人绑 → 404
    await expect(
      keys.create(ctx, stranger.id, { name: 'steal', subscriptionId: team.subscriptionId }),
    ).rejects.toMatchObject({ status: 404, code: 'subscription_not_usable' });

    // 成员被移除后既有绑定不删（历史归属），但新建被拒
    await org.removeMember(ctx, team.ownerId, team.orgId, member.id);
    await expect(
      keys.create(ctx, member.id, { name: 'again', subscriptionId: team.subscriptionId }),
    ).rejects.toMatchObject({ status: 404, code: 'subscription_not_usable' });
  });

  it('我的组织列表：附订阅信息（owner 视角）', async () => {
    const team = await newOrgTeam(2);
    const orgs = await org.listMyOrgs(ctx, team.ownerId);
    expect(orgs.length).toBe(1);
    expect(orgs[0]!.role).toBe('owner');
    expect(orgs[0]!.subscriptionId).toBe(team.subscriptionId);
    expect(orgs[0]!.quantity).toBe(2);
  });
});
