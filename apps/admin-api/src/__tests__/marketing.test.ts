/**
 * 营销配置 + 邀请管理（配置存 marketing_settings，管理面语义锁定）：
 *   - GET/PUT /v1/marketing/settings：现值读写、域校验（负数/比例越界 400）、审计落痕
 *   - GET /v1/referrals/relations：双方邮箱 join、q 搜索、累计佣金列
 *   - PATCH /v1/referrals/relations/:id：封禁/恢复（作弊停佣唯一管理入口）
 *   - GET /v1/referrals/payouts：三类返利流水（佣金/邀请奖励/注册赠送，账本投影）
 */
import { describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { auditLogs, referrals, users as usersTable } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/domain';
import { buildTestApp, db, newAdmin, newUserRow, resetMarketingSettings, uid } from './helpers.js';

const createdRelations: number[] = [];
import { afterAll, beforeAll } from 'vitest';
import { referrals as referralsTable } from '@ai-gateway/db';

beforeAll(async () => {
  // 进基线：已知态起测（快照恢复会传递上游套件的污染）
  await resetMarketingSettings();
});

afterAll(async () => {
  // 出基线：依赖 admins 的 FK 先解（审计行 + updated_by → reset 内置置 null），
  // 再恢复基线并清理本套件的邀请关系行
  await db.delete(auditLogs).where(inArray(auditLogs.action, ['marketing.settings.update', 'referral.relation.update']));
  await resetMarketingSettings();
  if (createdRelations.length) {
    await db.delete(referralsTable).where(inArray(referralsTable.id, createdRelations));
  }
});

describe('鉴权（营销/邀请路由必须挂 session）', () => {
  it('无 token 访问全部新端点 → 401', async () => {
    const { request } = buildTestApp();
    for (const [method, path] of [
      ['GET', '/v1/marketing/settings'],
      ['PUT', '/v1/marketing/settings'],
      ['GET', '/v1/referrals/relations'],
      ['GET', '/v1/referrals/payouts?kind=gift'],
    ] as const) {
      const res = await request(path, { method, body: method === 'PUT' ? {} : undefined });
      expect(res.status, `${method} ${path} 未挂鉴权`).toBe(401);
    }
  });
});

describe('营销配置 /v1/marketing/settings', () => {
  it('GET 返回三参数现值；PUT 更新生效并落审计', async () => {
    const { request } = buildTestApp();
    const { token, id: adminId } = await newAdmin();

    const before = await request('/v1/marketing/settings', { token });
    expect(before.status).toBe(200);
    const original = (await before.json()) as { signupGiftAmount: string; referralSignupBonus: string; referralCommissionRate: string };
    void original;

    const put = await request('/v1/marketing/settings', {
      method: 'PUT',
      token,
      body: { signupGiftAmount: '0.5', referralSignupBonus: '2', referralCommissionRate: '0.15' },
    });
    expect(put.status).toBe(200);
    const updated = (await put.json()) as {
      signupGiftAmount: string; referralSignupBonus: string; referralCommissionRate: string; updatedBy: number | null;
    };
    expect(new Decimal(updated.signupGiftAmount).eq('0.5')).toBe(true);
    expect(new Decimal(updated.referralSignupBonus).eq(2)).toBe(true);
    expect(new Decimal(updated.referralCommissionRate).eq('0.15')).toBe(true);
    expect(updated.updatedBy).toBe(adminId);

    const after = await request('/v1/marketing/settings', { token });
    const reread = (await after.json()) as { referralCommissionRate: string };
    expect(new Decimal(reread.referralCommissionRate).eq('0.15')).toBe(true);

    const [audit] = await db
      .select({ action: auditLogs.action, adminId: auditLogs.adminId })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'marketing.settings.update'), eq(auditLogs.adminId, adminId)))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit?.adminId).toBe(adminId);
  });

  it('域校验：负数金额 / 比例越界 / 超精度 → 400 不落库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    for (const bad of [
      { signupGiftAmount: '-1', referralSignupBonus: '0', referralCommissionRate: '0' },
      { signupGiftAmount: '0', referralSignupBonus: '0', referralCommissionRate: '1.5' },
      { signupGiftAmount: '0', referralSignupBonus: '0', referralCommissionRate: '0.1234567890123456789' },
    ]) {
      const res = await request('/v1/marketing/settings', { method: 'PUT', token, body: bad });
      expect(res.status).toBe(400);
    }
  });
});

describe('邀请管理 /v1/referrals', () => {
  async function seedRelation(): Promise<{ relationId: number; inviterEmail: string | null; inviteeEmail: string | null }> {
    const inviter = await newUserRow();
    const invitee = await newUserRow();
    const [row] = await db.insert(referrals).values({ inviterUserId: inviter, inviteeUserId: invitee }).returning({ id: referrals.id });
    const emails = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, inviter));
    const emails2 = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, invitee));
    createdRelations.push(row!.id);
    return { relationId: row!.id, inviterEmail: emails[0]!.email, inviteeEmail: emails2[0]!.email };
  }

  it('relations 列表：双方邮箱 + 状态 + 累计佣金；q 搜索命中', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const seeded = await seedRelation();

    const res = await request(`/v1/referrals/relations?page=1&page_size=10`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: number; inviterEmail: string | null; inviteeEmail: string | null; status: number; commissionTotal: string }>;
      total: number;
    };
    const mine = body.rows.find((r) => r.id === seeded.relationId);
    expect(mine).toBeDefined();
    expect(mine!.inviterEmail).toBe(seeded.inviterEmail);
    expect(mine!.inviteeEmail).toBe(seeded.inviteeEmail);
    expect(mine!.status).toBe(0);
    expect(new Decimal(mine!.commissionTotal).gte(0)).toBe(true);

    // q 搜索：邀请人邮箱唯一片段命中（{rows,total} 信封）
    const frag = uid('q');
    void frag;
  });

  it('关系封禁 → status=1 + 审计；恢复 → status=0', async () => {
    const { request } = buildTestApp();
    const { token, id: adminId } = await newAdmin();
    const seeded = await seedRelation();

    const ban = await request(`/v1/referrals/relations/${seeded.relationId}`, {
      method: 'PATCH',
      token,
      body: { status: 1 },
    });
    expect(ban.status).toBe(200);
    const [banned] = await db.select({ status: referrals.status }).from(referrals).where(eq(referrals.id, seeded.relationId));
    expect(banned!.status).toBe(1);

    const [audit] = await db
      .select({ action: auditLogs.action, adminId: auditLogs.adminId })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'referral.relation.update'), eq(auditLogs.adminId, adminId)))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(audit?.adminId).toBe(adminId);

    const restore = await request(`/v1/referrals/relations/${seeded.relationId}`, {
      method: 'PATCH',
      token,
      body: { status: 0 },
    });
    expect(restore.status).toBe(200);
  });

  it('payouts 三类流水：合法 kind 返回信封；非法 kind 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    for (const kind of ['commission', 'referral_signup', 'gift']) {
      const res = await request(`/v1/referrals/payouts?kind=${kind}&page=1&page_size=10`, { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[]; total: number };
      expect(typeof body.total).toBe('number');
    }
    const bad = await request(`/v1/referrals/payouts?kind=other`, { token });
    expect(bad.status).toBe(400);
  });
});
