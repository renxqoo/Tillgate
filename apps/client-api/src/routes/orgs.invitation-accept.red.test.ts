import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  orgInvitations,
  orgMembers,
  organizations,
  plans,
  userSubscriptions,
  users,
} from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { orgRoutes } from './orgs.js';
import { makeClientTestApp, makeServices } from '../test/helpers.js';

/**
 * M2 回归锁定：邀请接受（accept）的 TOCTOU。
 *   - 可见分支：已撤销邀请 → 409 INVITATION_REVOKED（非笼统 404）；
 *     已过期邀请 → 409 INVITATION_EXPIRED；两种情况都不得把人加进组织。
 *   - 0 行静默分支（真复现）：accept 事务内「插入成员 → 翻转邀请状态」之间
 *     邀请被并发撤销——用 org_members AFTER INSERT 触发器把该组织的 pending
 *     邀请改成 revoked，模拟撤销恰好在状态翻转前落地。修复前：翻转 WHERE
 *     status=0 匹配 0 行且结果未校验 → 200 + 成员已加入 + 邀请却是 revoked；
 *     修复后：事务内校验翻转结果 → 409 且成员插入一并回滚。
 * 数据纪律：全部 p1api- 前缀，finally 只删自己创建的行（含触发器/函数）。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);

let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

interface Fixture {
  orgId: number;
  inviteeId: number;
  invitationId: number;
  token: string;
  cleanup: () => Promise<void>;
}

/** 组织 + owner + 有效订阅 + 一条可控状态的邀请（邀请行直插，绕开创建路由的 pending 限制） */
async function setupOrgWithInvitation(
  suffix: string,
  invitation: { status: number; expiresAt: Date },
): Promise<Fixture> {
  const email = `${suffix}@p1api.local`;
  const [owner] = await db
    .insert(users)
    .values({ issuer: 'local', subject: `p1api-owner-${suffix}`, identityProvider: 'local' })
    .returning({ id: users.id });
  const [invitee] = await db
    .insert(users)
    .values({ issuer: 'local', subject: `p1api-inv-${suffix}`, identityProvider: 'local', email })
    .returning({ id: users.id });
  const [plan] = await db
    .insert(plans)
    .values({
      name: `p1api-plan-${suffix}`.slice(0, 32),
      kind: 'subscription',
      price: '10',
      periodDays: 30,
      quotaAmount: '10',
      sortOrder: 1,
      allowSeats: true,
      status: 0,
    })
    .returning({ id: plans.id });
  const [org] = await db
    .insert(organizations)
    .values({ name: `p1api-org-${suffix}`, ownerUserId: owner!.id })
    .returning({ id: organizations.id });
  await db
    .insert(orgMembers)
    .values({ orgId: org!.id, userId: owner!.id, role: 'owner', status: 0 });
  await db.insert(userSubscriptions).values({
    userId: owner!.id,
    planId: plan!.id,
    orgId: org!.id,
    startAt: new Date(),
    endAt: new Date(Date.now() + 86_400_000),
    quotaAmount: '10',
    quantity: 5,
    price: '10',
    status: 0,
  });
  const token = `p1api${suffix.replace(/[^0-9a-z]/gi, '')}`.slice(0, 60);
  const [inv] = await db
    .insert(orgInvitations)
    .values({
      orgId: org!.id,
      email,
      token,
      invitedByUserId: owner!.id,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .returning({ id: orgInvitations.id });

  return {
    orgId: org!.id,
    inviteeId: invitee!.id,
    invitationId: inv!.id,
    token,
    cleanup: async () => {
      await db.delete(orgInvitations).where(eq(orgInvitations.orgId, org!.id));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.orgId, org!.id));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, org!.id));
      await db.delete(organizations).where(eq(organizations.id, org!.id));
      await db.delete(plans).where(eq(plans.id, plan!.id));
      await db.delete(users).where(eq(users.id, invitee!.id));
      await db.delete(users).where(eq(users.id, owner!.id));
    },
  };
}

async function activeMemberCount(orgId: number, userId: number): Promise<number> {
  const rows = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)));
  return rows.length;
}

/** 竞态注入：成员插入后立刻撤销该组织的 pending 邀请（模拟 owner 并发撤销） */
async function installRaceTrigger(orgId: number): Promise<void> {
  await db.execute(sql`
    create or replace function p1api_revoke_during_accept() returns trigger as $$
    begin
      update org_invitations set status = 2, updated_at = now()
      where org_id = new.org_id and status = 0;
      return new;
    end;
    $$ language plpgsql
  `);
  await db.execute(sql`drop trigger if exists p1api_accept_race on org_members`);
  await db.execute(sql`
    create trigger p1api_accept_race after insert on org_members
    for each row execute function p1api_revoke_during_accept()
  `);
  void orgId;
}

async function dropRaceTrigger(): Promise<void> {
  await db.execute(sql`drop trigger if exists p1api_accept_race on org_members`);
  await db.execute(sql`drop function if exists p1api_revoke_during_accept()`);
}

describe('组织邀请 accept（M2：TOCTOU 与错误语义）', () => {
  it('已撤销邀请（status=2）→ 409 INVITATION_REVOKED，不加入成员', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = `r${Date.now()}`;
    const fx = await setupOrgWithInvitation(`rev${suffix}`, {
      status: 2,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const app = makeClientTestApp(fx.inviteeId, { '/orgs': orgRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/orgs/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: fx.token }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('INVITATION_REVOKED');
      expect(await activeMemberCount(fx.orgId, fx.inviteeId)).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  it('已过期邀请（expiresAt 过去）→ 409 INVITATION_EXPIRED，不加入成员', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = `x${Date.now()}`;
    const fx = await setupOrgWithInvitation(`exp${suffix}`, {
      status: 0,
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    const app = makeClientTestApp(fx.inviteeId, { '/orgs': orgRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/orgs/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: fx.token }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('INVITATION_EXPIRED');
      expect(await activeMemberCount(fx.orgId, fx.inviteeId)).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  it('竞态：事务内插入成员后邀请被撤销（触发器模拟）→ 409 且成员插入回滚', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = `c${Date.now()}`;
    const fx = await setupOrgWithInvitation(`race${suffix}`, {
      status: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const app = makeClientTestApp(fx.inviteeId, { '/orgs': orgRoutes(makeServices(db)) });
    try {
      await installRaceTrigger(fx.orgId);
      const res = await app.request('/api/orgs/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: fx.token }),
      });
      // 修复前：update 匹配 0 行未校验 → 200 + 成员已加入（半成品状态）
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('INVITATION_REVOKED');
      // 成员插入必须随事务回滚
      expect(await activeMemberCount(fx.orgId, fx.inviteeId)).toBe(0);
    } finally {
      await dropRaceTrigger();
      await fx.cleanup();
    }
  });

  it('正常路径回归：有效邀请 → 200 且成员加入、邀请 accepted', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = `o${Date.now()}`;
    const fx = await setupOrgWithInvitation(`ok${suffix}`, {
      status: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const app = makeClientTestApp(fx.inviteeId, { '/orgs': orgRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/orgs/invitations/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: fx.token }),
      });
      expect(res.status).toBe(200);
      expect(await activeMemberCount(fx.orgId, fx.inviteeId)).toBe(1);
      const inv = await db.query.orgInvitations.findFirst({
        where: eq(orgInvitations.id, fx.invitationId),
      });
      expect(inv?.status).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });
});
