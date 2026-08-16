import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, plans, userSubscriptions, organizations, orgMembers, orgInvitations } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { orgRoutes } from '../orgs.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * A3 回归锁定（R7 功能）：org 邀请撤销路由 + 待接受上限。
 *   - 上限：pending ≥ min(剩余席位×2, 20) → 409 INVITATIONS_FULL
 *   - 撤销：owner 200（status 0→2）；重复撤销/撤销已接受 → 404；非 owner → 403
 *   - GET /:id owner 可见 pending 列表（不含 token）
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
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

describe('org 邀请上限与撤销（A3）', () => {
  it('席位 3：pending 上限 4 → 第 5 条 409 INVITATIONS_FULL；撤销后可再邀；非 owner 403；重复撤销 404', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [owner] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__a3o_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [stranger] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__a3x_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [plan] = await db
      .insert(plans)
      .values({ name: `__a3plan_${s}`.slice(0, 32), kind: 'subscription', price: '10', periodDays: 30, quotaAmount: '10', sortOrder: 1, allowSeats: true, status: 0 })
      .returning({ id: plans.id });
    const [org] = await db
      .insert(organizations)
      .values({ name: `__a3org_${s}`, ownerUserId: owner!.id })
      .returning({ id: organizations.id });
    await db.insert(orgMembers).values({ orgId: org!.id, userId: owner!.id, role: 'owner', status: 0 });
    await db.insert(userSubscriptions).values({
      userId: owner!.id,
      planId: plan!.id,
      orgId: org!.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 86_400_000),
      quotaAmount: '10',
      quantity: 3, // owner 占 1 → 剩余 2 → 待接受上限 min(max(2,1)*2,20)=4
      price: '10',
      status: 0,
    });
    const ownerApp = makeClientTestApp(owner!.id, { '/orgs': orgRoutes(makeServices(db)) });
    const strangerApp = makeClientTestApp(stranger!.id, { '/orgs': orgRoutes(makeServices(db)) });
    try {
      // 上限：前 2 条 201，第 3 条 409
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await ownerApp.request(`/api/orgs/${org!.id}/invitations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: `m${i}_${s}@x.local` }),
        });
        if (i < 4) {
          expect(res.status, `第 ${i + 1} 条邀请应成功`).toBe(201);
          const b = (await res.json()) as { invitation: { id: number } };
          ids.push(b.invitation.id);
        } else {
          expect(res.status).toBe(409);
          const b = (await res.json()) as { error?: { code?: string } };
          expect(b.error?.code).toBe('INVITATIONS_FULL');
        }
      }

      // owner 详情可见 pending（2 条，不含 token）
      const detail = await ownerApp.request(`/api/orgs/${org!.id}`);
      const d = (await detail.json()) as { invitations?: Array<{ id: number; token?: string }> };
      expect(d.invitations?.length).toBe(4);
      expect(d.invitations?.every((i) => i.token === undefined)).toBe(true);

      // 非 owner（非成员）撤销 → 403
      const forbidden = await strangerApp.request(`/api/orgs/${org!.id}/invitations/${ids[0]}/revoke`, { method: 'POST' });
      expect(forbidden.status).toBe(403);

      // owner 撤销 → 200；重复 → 404
      const revoke = await ownerApp.request(`/api/orgs/${org!.id}/invitations/${ids[0]}/revoke`, { method: 'POST' });
      expect(revoke.status).toBe(200);
      const row = await db.query.orgInvitations.findFirst({ where: eq(orgInvitations.id, ids[0]!) });
      expect(row?.status).toBe(2);
      const again = await ownerApp.request(`/api/orgs/${org!.id}/invitations/${ids[0]}/revoke`, { method: 'POST' });
      expect(again.status).toBe(404);

      // 撤销释放额度：可再邀 1 条（pending 回到 2）
      const refill = await ownerApp.request(`/api/orgs/${org!.id}/invitations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `refill_${s}@x.local` }),
      });
      expect(refill.status).toBe(201);
    } finally {
      await db.delete(orgInvitations).where(eq(orgInvitations.orgId, org!.id));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.orgId, org!.id));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, org!.id));
      await db.delete(organizations).where(eq(organizations.id, org!.id));
      await db.delete(plans).where(eq(plans.id, plan!.id));
      await db.delete(users).where(eq(users.id, owner!.id));
      await db.delete(users).where(eq(users.id, stranger!.id));
    }
  });
});
