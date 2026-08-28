/**
 * 团队套餐组织旅程 E2E（老仓 e2e-org-team 迁移）：企业用户购买团队档 →
 * ensureOrg 组织诞生 → 邀请（token 一次下发）→ 被邀人接受 → 成员限额 →
 * 成员 Key 绑组织订阅 → 移除成员。owner 不可移除自证。
 * 旅程步骤拆为模块级阶段函数（.e2e.ts 不在 root override 的 *.test.ts 放宽集内——
 * 规模限制生效；断言逐字随迁，仅变量管道化）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  apiClient,
  bootHarness,
  cleanupSeeds,
  cleanupUsers,
  defined,
  infraReady,
  registerUser,
  reservePort,
  seedPlan,
  seedRedeemCode,
  walletBalance,
  type E2eHarness,
} from './harness.js';

const context = describe.skipIf(!(await infraReady()));

/** 用户面 API 客户端形状（阶段函数入参） */
type Api = ReturnType<typeof apiClient>;

let h: E2eHarness;
let api: Api;
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

// ---------------------------------------------------------------------------
// 旅程阶段（模块级——it 体保持线性编排，断言与原实现逐字等价）
// ---------------------------------------------------------------------------

/** owner 旅程上下文（购买阶段的产出——后续阶段的入参） */
interface OwnerContext {
  ownerToken: string;
  ownerUserId: number;
  orgId: number;
}

/** owner：注册 → 企业标记 → 兑换码充值 → 购买团队档（ensureOrg 组织诞生） */
async function ownerPurchasesTeamPlan(
  client: Api,
  harness: E2eHarness,
  input: { ownerEmail: string; runTag: string; teamPlanId: number },
): Promise<OwnerContext> {
  const owner = await registerUser(harness, input.ownerEmail, 'org-owner-pass-123');
  await harness.assembly.db.execute(
    sql`update users set is_enterprise = true where id = ${owner.userId}`,
  );

  const beforeRedeem = await walletBalance(client, owner.token);
  expect(
    (
      await client('/v1/redeem', {
        method: 'POST',
        token: owner.token,
        body: JSON.stringify({ code: `E2E-OT-${input.runTag}` }),
      })
    ).status,
  ).toBe(200);

  const purchase = await client('/v1/subscriptions', {
    method: 'POST',
    token: owner.token,
    body: JSON.stringify({ planId: input.teamPlanId, quantity: 3 }),
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
  return {
    ownerToken: owner.token,
    ownerUserId: owner.userId,
    orgId: purchaseBody.orgId ?? 0,
  };
}

/** 我的组织：订阅富化（planName/remaining）与详情（owner 成员）→ 邀请（token 一次下发；列表永不回 token） */
async function orgDetailAndInvite(
  client: Api,
  input: { ownerToken: string; orgId: number; memberEmail: string },
): Promise<string> {
  const orgs = (await (await client('/v1/orgs', { token: input.ownerToken })).json()) as {
    rows: Array<{
      orgId: number;
      role: string;
      planName: string | null;
      remainingAmount: string;
    }>;
  };
  expect(orgs.rows).toHaveLength(1);
  const orgRow = defined(orgs.rows[0], 'org row');
  expect(orgRow.orgId).toBe(input.orgId);
  expect(orgRow.role).toBe('owner');
  expect(orgRow.planName).toBe('e2e-team');
  expect(orgRow.remainingAmount).toBe('30');

  const detail = (await (
    await client(`/v1/orgs/${orgRow.orgId}`, { token: input.ownerToken })
  ).json()) as { members: Array<{ role: string }>; invitations: unknown[] };
  expect(detail.members).toHaveLength(1);
  expect(detail.members[0]?.role).toBe('owner');

  const invited = await client(`/v1/orgs/${orgRow.orgId}/invitations`, {
    method: 'POST',
    token: input.ownerToken,
    body: JSON.stringify({ email: input.memberEmail }),
  });
  expect(invited.status).toBe(201);
  const inviteBody = (await invited.json()) as { invitationId: number; token: string };
  expect(inviteBody.token.length).toBeGreaterThan(0);
  return inviteBody.token;
}

/** 被邀人：注册 → 接受（邮箱匹配）→ 组织成员 → 限额修补 → 成员 Key 绑组织订阅 */
async function memberJoinsAndBindsKey(
  client: Api,
  harness: E2eHarness,
  input: { memberEmail: string; orgId: number; inviteToken: string; ownerToken: string },
): Promise<number> {
  const member = await registerUser(harness, input.memberEmail, 'org-member-pass-123');
  const accept = await client('/v1/orgs/invitations/accept', {
    method: 'POST',
    token: member.token,
    body: JSON.stringify({ token: input.inviteToken }),
  });
  expect(await accept.json()).toEqual({ orgId: input.orgId });

  const afterJoin = (await (
    await client(`/v1/orgs/${input.orgId}`, { token: input.ownerToken })
  ).json()) as { members: unknown[] };
  expect(afterJoin.members).toHaveLength(2);

  // 成员限额修补
  expect(
    await (
      await client(`/v1/orgs/${input.orgId}/members/${member.userId}`, {
        method: 'PATCH',
        token: input.ownerToken,
        body: JSON.stringify({ dailySpendLimit: '1', monthlyQuota: '2' }),
      })
    ).json(),
  ).toEqual({ ok: true });

  // 成员 Key：绑定组织订阅（owner 组织的 active 订阅 id）
  const memberOrgs = (await (await client('/v1/orgs', { token: member.token })).json()) as {
    rows: Array<{ orgId: number; subscriptionId: number | null; role: string }>;
  };
  expect(memberOrgs.rows[0]?.role).toBe('member');
  const orgSubId = memberOrgs.rows[0]?.subscriptionId;
  expect(orgSubId).not.toBeNull();
  const memberKey = await client('/v1/keys', {
    method: 'POST',
    token: member.token,
    body: JSON.stringify({ name: 'member-key', subscriptionId: orgSubId }),
  });
  expect(memberKey.status).toBe(201);
  const memberKeyBody = (await memberKey.json()) as { plaintext: string };
  expect(memberKeyBody.plaintext.startsWith('sk_')).toBe(true);
  return member.userId;
}

/** 移除成员；owner 不可自移 */
async function removeMemberAndOwnerGuard(
  client: Api,
  input: { ownerToken: string; ownerUserId: number; memberUserId: number; orgId: number },
): Promise<void> {
  expect(
    await (
      await client(`/v1/orgs/${input.orgId}/members/${input.memberUserId}`, {
        method: 'DELETE',
        token: input.ownerToken,
      })
    ).json(),
  ).toEqual({ ok: true });
  const removeOwner = await client(`/v1/orgs/${input.orgId}/members/${input.ownerUserId}`, {
    method: 'DELETE',
    token: input.ownerToken,
  });
  expect(removeOwner.status).toBe(409);
  expect(((await removeOwner.json()) as { error: { code: string } }).error.code).toBe(
    'accounts.org_cannot_remove_owner',
  );
}

context('团队套餐组织旅程（老仓 e2e-org-team 核销）', () => {
  it('团队购买 → 组织诞生 → 邀请/接受 → 限额 → 成员 Key → 移除', async () => {
    const ownerCtx = await ownerPurchasesTeamPlan(api, h, {
      ownerEmail,
      runTag,
      teamPlanId,
    });
    users.push({ id: ownerCtx.ownerUserId, email: ownerEmail });
    const inviteToken = await orgDetailAndInvite(api, {
      ownerToken: ownerCtx.ownerToken,
      orgId: ownerCtx.orgId,
      memberEmail,
    });
    const memberUserId = await memberJoinsAndBindsKey(api, h, {
      memberEmail,
      orgId: ownerCtx.orgId,
      inviteToken,
      ownerToken: ownerCtx.ownerToken,
    });
    users.push({ id: memberUserId, email: memberEmail });
    await removeMemberAndOwnerGuard(api, {
      ownerToken: ownerCtx.ownerToken,
      ownerUserId: ownerCtx.ownerUserId,
      memberUserId,
      orgId: ownerCtx.orgId,
    });
  }, 180_000);
});
