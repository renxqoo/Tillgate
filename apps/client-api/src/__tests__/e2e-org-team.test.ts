/**
 * E2E ② 组织团队全链（真服务进程 + 真 HTTP）：
 * 企业用户买团队套餐（组织同事务诞生）→ owner 视角 → 邀请成员（真注册用户）→
 * 成员接受 → 成员 Key 绑组织订阅 → owner 设成员限额 → 移除成员（绑定降闸）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db';
import {
  E2EFixtures,
  e2eDb,
  errCode,
  expectAmountEq,
  http,
  signedEpayNotify,
  startClientApi,
  type E2EClientApi,
} from './e2e-kit.js';

let api: E2EClientApi;
let fx: E2EFixtures;

beforeAll(async () => {
  const db = e2eDb();
  api = await startClientApi(db);
  fx = new E2EFixtures(db);
});

afterAll(async () => {
  await fx.cleanup();
  await api.stop();
  await api.db.$client.end().catch(() => {});
});

/** 注册 + 提为企业用户 + 充值（epay 真签名回调） */
async function enterpriseOwner(): Promise<{ userId: number; token: string; email: string }> {
  const owner = await fx.registerViaHttp(api.baseUrl);
  await api.db.update(users).set({ isEnterprise: true }).where(eq(users.id, owner.userId));
  const order = await http(api.baseUrl, 'POST', '/v1/payments/orders', {
    token: owner.token,
    body: { amount: '500' },
  });
  const { orderId } = order.body as { orderId: string };
  const notify = await http(api.baseUrl, 'POST', '/v1/payments/notify/epay', {
    contentType: 'application/x-www-form-urlencoded',
    body: signedEpayNotify(orderId, '500'),
  });
  expect(notify.text).toBe('success');
  return owner;
}

describe('E2E ② 组织团队全链', () => {
  it('企业买团队套餐 → 组织诞生 → owner 视角（我的组织带订阅信息）', async () => {
    const owner = await enterpriseOwner();
    const teamId = await fx.seedPlan({ price: '100', quotaAmount: '1000', allowSeats: true, sortOrder: 3 });
    const purchase = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: owner.token,
      body: { planId: teamId, quantity: 3 },
    });
    expect(purchase.status).toBe(201);
    const body = purchase.body as { orgId: number | null; quantity: number; quotaAmount: string };
    expect(body.orgId).not.toBeNull();
    fx.orgIds.push(body.orgId!);
    expect(body.quantity).toBe(3);
    expectAmountEq(body.quotaAmount, '3000');
    expectAmountEq(await fx.balanceOf(owner.userId), '200'); // 500 − 100×3

    const orgs = await http(api.baseUrl, 'GET', '/v1/orgs', { token: owner.token });
    const row = (orgs.body as { rows: { orgId: number; role: string; quantity: number; subscriptionId: number | null }[] }).rows[0]!;
    expect(row.orgId).toBe(body.orgId);
    expect(row.role).toBe('owner');
    expect(row.quantity).toBe(3);
    expect(row.subscriptionId).not.toBeNull();
  });

  it('邀请 → 成员接受 → 成员视角（详情可见成员，不可见邀请）→ 成员 Key 绑组织订阅', async () => {
    const owner = await enterpriseOwner();
    const member = await fx.registerViaHttp(api.baseUrl);
    const teamId = await fx.seedPlan({ price: '100', quotaAmount: '1000', allowSeats: true, sortOrder: 3 });
    const purchase = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: owner.token,
      body: { planId: teamId, quantity: 2 },
    });
    const { orgId, subscriptionId } = purchase.body as { orgId: number; subscriptionId: number };
    fx.orgIds.push(orgId!);

    // 邀请邮箱不匹配的第三人 → 接受 403
    const stranger = await fx.registerViaHttp(api.baseUrl);
    const invForStranger = await http(api.baseUrl, 'POST', `/v1/orgs/${orgId}/invitations`, {
      token: owner.token,
      body: { email: member.email },
    });
    expect(invForStranger.status).toBe(201);
    const invitation = invForStranger.body as { invitationId: number; token: string };
    const wrongAccept = await http(api.baseUrl, 'POST', '/v1/orgs/invitations/accept', {
      token: stranger.token,
      body: { token: invitation.token },
    });
    expect(wrongAccept.status).toBe(403);
    expect(errCode(wrongAccept)).toBe('invitation_email_mismatch');

    // 成员接受 → 详情视角
    const accept = await http(api.baseUrl, 'POST', '/v1/orgs/invitations/accept', {
      token: member.token,
      body: { token: invitation.token },
    });
    expect(accept.status).toBe(200);
    const memberDetail = await http(api.baseUrl, 'GET', `/v1/orgs/${orgId}`, { token: member.token });
    const detail = memberDetail.body as { members: { userId: number; role: string }[]; invitations: unknown[] };
    expect(detail.members.length).toBe(2);
    expect(detail.invitations.length).toBe(0); // 邀请列表仅 owner 可见

    // 成员 Key 绑组织订阅（成员有权）
    const key = await http(api.baseUrl, 'POST', '/v1/keys', {
      token: member.token,
      body: { name: 'team-key', subscriptionId },
    });
    expect(key.status).toBe(201);
    expect((key.body as { subscriptionId: number }).subscriptionId).toBe(subscriptionId);

    // owner 设成员限额 → 移除成员 → 成员再绑被拒
    const patch = await http(api.baseUrl, 'PATCH', `/v1/orgs/${orgId}/members/${member.userId}`, {
      token: owner.token,
      body: { dailySpendLimit: '10', monthlyQuota: '200' },
    });
    expect(patch.status).toBe(200);
    const remove = await http(api.baseUrl, 'DELETE', `/v1/orgs/${orgId}/members/${member.userId}`, {
      token: member.token, // 成员自己无权移除
    });
    expect(remove.status).toBe(403);
    const removeByOwner = await http(api.baseUrl, 'DELETE', `/v1/orgs/${orgId}/members/${member.userId}`, {
      token: owner.token,
    });
    expect(removeByOwner.status).toBe(200);
    const keyAfterRemove = await http(api.baseUrl, 'POST', '/v1/keys', {
      token: member.token,
      body: { name: 'no-more', subscriptionId },
    });
    expect(keyAfterRemove.status).toBe(404);
    expect(errCode(keyAfterRemove)).toBe('subscription_not_usable');
  });

  it('席位闸：quantity=1 团队（owner 占满）→ 邀请 409 seats_full', async () => {
    const owner = await enterpriseOwner();
    const member = await fx.registerViaHttp(api.baseUrl);
    const teamId = await fx.seedPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
    const purchase = await http(api.baseUrl, 'POST', '/v1/subscriptions', {
      token: owner.token,
      body: { planId: teamId, quantity: 1 },
    });
    const { orgId } = purchase.body as { orgId: number };
    fx.orgIds.push(orgId!);
    const invite = await http(api.baseUrl, 'POST', `/v1/orgs/${orgId}/invitations`, {
      token: owner.token,
      body: { email: member.email },
    });
    expect(invite.status).toBe(409);
    expect(errCode(invite)).toBe('seats_full');
  });
});
