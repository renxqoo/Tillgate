/**
 * 团队套餐组织旅程 E2E（老仓 e2e-org-team 迁移）：企业用户购买团队档 →
 * ensureOrg 组织诞生 → 邀请（token 一次下发）→ 被邀人接受 → 成员限额 →
 * 成员 Key 绑组织订阅 → 移除成员。owner 不可移除自证。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  apiClient,
  bootHarness,
  cleanupSeeds,
  cleanupUsers,
  infraReady,
  registerUser,
  reservePort,
  seedPlan,
  seedRedeemCode,
  walletBalance,
  type E2eHarness,
} from './harness.js';

const context = describe.skipIf(!(await infraReady()));

let h: E2eHarness;
let api: ReturnType<typeof apiClient>;
const runTag = `e2e-ot-${Date.now().toString(36)}`;
const ownerEmail = `${runTag}-owner@example.com`;
const memberEmail = `${runTag}-member@example.com`;
const users: Array<{ id: number; email: string }> = [];
let teamPlanId = 0;

beforeAll(async () => {
  const port = await reservePort();
  h = await bootHarness({ appPort: port });
  api = apiClient(h.baseUrl);
  await seedRedeemCode(h.assembly.db, `E2E-OT-${runTag}`, '5');
  teamPlanId = await seedPlan(h.assembly.db, 'e2e-team', true);
});

afterAll(async () => {
  await cleanupUsers(h.assembly.db, users);
  await cleanupSeeds(h.assembly.db);
  await h.teardown();
});

context('团队套餐组织旅程（老仓 e2e-org-team 核销）', () => {
  it('团队购买 → 组织诞生 → 邀请/接受 → 限额 → 成员 Key → 移除', async () => {
    // owner：注册 → 企业标记 → 兑换码充值 → 购买团队档（ensureOrg 组织诞生）
    const owner = await registerUser(h, api, ownerEmail, 'org-owner-pass-123');
    users.push({ id: owner.userId, email: ownerEmail });
    await h.assembly.db.execute(
      sql`update users set is_enterprise = true where id = ${owner.userId}`,
    );

    const beforeRedeem = await walletBalance(api, owner.token);
    expect(
      (
        await api('/v1/redeem', {
          method: 'POST',
          token: owner.token,
          body: JSON.stringify({ code: `E2E-OT-${runTag}` }),
        })
      ).status,
    ).toBe(200);

    const purchase = await api('/v1/subscriptions', {
      method: 'POST',
      token: owner.token,
      body: JSON.stringify({ planId: teamPlanId, quantity: 3 }),
    });
    expect(purchase.status).toBe(201);
    const purchaseBody = (await purchase.json()) as {
      orgId: number | null;
      quantity: number;
      quotaAmount: string;
    };
    expect(purchaseBody.orgId).not.toBeNull();
    expect(purchaseBody.quantity).toBe(3);
    expect(purchaseBody.quotaAmount).toBe('30'); // 档额度 10 × 席位 3
    void beforeRedeem;

    // 我的组织：订阅富化（planName/remaining）与详情（owner 成员）
    const orgs = (await (await api('/v1/orgs', { token: owner.token })).json()) as {
      rows: Array<{
        orgId: number;
        role: string;
        planName: string | null;
        remainingAmount: string;
      }>;
    };
    expect(orgs.rows).toHaveLength(1);
    const orgRow = orgs.rows[0]!;
    expect(orgRow.orgId).toBe(purchaseBody.orgId);
    expect(orgRow.role).toBe('owner');
    expect(orgRow.planName).toBe('e2e-team');
    expect(orgRow.remainingAmount).toBe('30');

    const detail = (await (
      await api(`/v1/orgs/${orgRow.orgId}`, { token: owner.token })
    ).json()) as { members: Array<{ role: string }>; invitations: unknown[] };
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0]?.role).toBe('owner');

    // 邀请：token 一次下发；列表永不回 token
    const invited = await api(`/v1/orgs/${orgRow.orgId}/invitations`, {
      method: 'POST',
      token: owner.token,
      body: JSON.stringify({ email: memberEmail }),
    });
    expect(invited.status).toBe(201);
    const inviteBody = (await invited.json()) as { invitationId: number; token: string };
    expect(inviteBody.token.length).toBeGreaterThan(0);

    // 被邀人：注册 → 接受（邮箱匹配）→ 组织成员
    const member = await registerUser(h, api, memberEmail, 'org-member-pass-123');
    users.push({ id: member.userId, email: memberEmail });
    const accept = await api('/v1/orgs/invitations/accept', {
      method: 'POST',
      token: member.token,
      body: JSON.stringify({ token: inviteBody.token }),
    });
    expect(await accept.json()).toEqual({ orgId: orgRow.orgId });

    const afterJoin = (await (
      await api(`/v1/orgs/${orgRow.orgId}`, { token: owner.token })
    ).json()) as { members: unknown[] };
    expect(afterJoin.members).toHaveLength(2);

    // 成员限额修补
    expect(
      await (
        await api(`/v1/orgs/${orgRow.orgId}/members/${member.userId}`, {
          method: 'PATCH',
          token: owner.token,
          body: JSON.stringify({ dailySpendLimit: '1', monthlyQuota: '2' }),
        })
      ).json(),
    ).toEqual({ ok: true });

    // 成员 Key：绑定组织订阅（owner 组织的 active 订阅 id）
    const memberOrgs = (await (await api('/v1/orgs', { token: member.token })).json()) as {
      rows: Array<{ orgId: number; subscriptionId: number | null; role: string }>;
    };
    expect(memberOrgs.rows[0]?.role).toBe('member');
    const orgSubId = memberOrgs.rows[0]?.subscriptionId;
    expect(orgSubId).not.toBeNull();
    const memberKey = await api('/v1/keys', {
      method: 'POST',
      token: member.token,
      body: JSON.stringify({ name: 'member-key', subscriptionId: orgSubId }),
    });
    expect(memberKey.status).toBe(201);
    const memberKeyBody = (await memberKey.json()) as { plaintext: string };
    expect(memberKeyBody.plaintext.startsWith('ag_')).toBe(true);

    // 移除成员；owner 不可自移
    expect(
      await (
        await api(`/v1/orgs/${orgRow.orgId}/members/${member.userId}`, {
          method: 'DELETE',
          token: owner.token,
        })
      ).json(),
    ).toEqual({ ok: true });
    const removeOwner = await api(`/v1/orgs/${orgRow.orgId}/members/${owner.userId}`, {
      method: 'DELETE',
      token: owner.token,
    });
    expect(removeOwner.status).toBe(409);
    expect(((await removeOwner.json()) as { error: { code: string } }).error.code).toBe(
      'accounts.org_cannot_remove_owner',
    );
  }, 180_000);
});
