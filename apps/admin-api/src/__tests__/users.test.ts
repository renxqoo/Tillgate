/**
 * 用户管理语义（v1 users-enterprise-filter / user-password-hash-leak /
 * set-password / users-transactions-range 的 v2 对位）：
 *   - 企业过滤闭包（enterprise=1/0 与 q 组合精确命中）
 *   - 响应体永不泄漏密码哈希（camel/snake/scrypt 格式三查）
 *   - set-password：本地账号守卫 / 默认卡「标准」绑定 + 全局系数回填 / 密码真改
 *   - 流水：三条入金 newest-first + 余额链；非法日期仍 400
 *   - 封禁语义：freezeReason 只随封禁；解封清原因
 *   - 调账数值域：'1e309'(Infinity)/1e10 → 400；正负调账落账
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { verifyPassword } from '@ai-gateway/identity-core';
import { rateCardCoefficients, rateCards, users as usersTable } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/domain';
import {
  buildTestApp,
  db,
  fundUser,
  newAdmin,
  newUserRow,
  uid,
} from './helpers.js';

describe('企业过滤闭包', () => {
  it('enterprise=1 只返回企业用户；enterprise=0 只返回个人用户（与 q 组合）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const stamp = uid('ent');
    const corporate = await newUserRow();
    const personal = await newUserRow();
    await db
      .update(usersTable)
      .set({ isEnterprise: true, subject: `${stamp}-corp` })
      .where(eq(usersTable.id, corporate));
    await db.update(usersTable).set({ subject: `${stamp}-personal` }).where(eq(usersTable.id, personal));

    const corp = (await (
      await request(`/v1/users?q=${stamp}&enterprise=1`, { token })
    ).json()) as { rows: Array<{ subject: string }>; total: number };
    expect(corp.total).toBe(1);
    expect(corp.rows[0]!.subject).toBe(`${stamp}-corp`);

    const indi = (await (
      await request(`/v1/users?q=${stamp}&enterprise=0`, { token })
    ).json()) as { rows: Array<{ subject: string }>; total: number };
    expect(indi.total).toBe(1);
    expect(indi.rows[0]!.subject).toBe(`${stamp}-personal`);
  });

  it('列表信封 + 钱包富化（balance/availableBalance）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    await fundUser(userId, '10');
    const [row0] = await db.select({ subject: usersTable.subject }).from(usersTable).where(eq(usersTable.id, userId));
    const list = (await (
      await request(`/v1/users?q=${row0!.subject}`, { token })
    ).json()) as { rows: Array<{ subject: string; balance: string; availableBalance: string }>; total: number };
    const mine = list.rows.find((r) => r.subject === row0!.subject);
    expect(mine).toBeTruthy();
    expect(new Decimal(mine!.balance).eq(10)).toBe(true);
    expect(new Decimal(mine!.availableBalance).eq(10)).toBe(true);
  });
});

describe('密码哈希泄漏红线', () => {
  it('PATCH 响应体不含 passwordHash（camel/snake/scrypt 格式三查）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const res = await request(`/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { displayName: 'changed-by-admin' },
    });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('password_hash');
    expect(text).not.toMatch(/[0-9a-f]+:[0-9a-f]+:\d+:\d+:\d+/);
  });
});

describe('set-password（管理员重置用户密码）', () => {
  it('本地账号 → 密码真改 + 默认卡「标准」绑定 + 全局系数回填', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();

    // 默认卡「标准」：找到现成的或建一张（本测试结束即清）；不预置全局系数——验证回填
    let [standard] = await db.select().from(rateCards).where(eq(rateCards.name, '标准'));
    let createdHere = false;
    if (!standard) {
      [standard] = await db.insert(rateCards).values({ name: '标准' }).returning();
      createdHere = true;
    }

    const res = await request(`/v1/users/${userId}/set-password`, {
      token,
      body: { password: 'NewSecretPass1' },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(await verifyPassword('NewSecretPass1', row!.passwordHash!)).toBe(true);
    expect(row!.rateCardId).toBe(standard!.id);
    const [coeff] = await db
      .select()
      .from(rateCardCoefficients)
      .where(eq(rateCardCoefficients.rateCardId, standard!.id));
    expect(coeff?.coefficient).toBe('1.000'); // 回填

    // 清理：解绑用户；自建卡连系数一并删（共享卡保留——其他数据可能引用）
    await db.update(usersTable).set({ rateCardId: null }).where(eq(usersTable.id, userId));
    if (createdHere) {
      await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, standard!.id));
      await db.delete(rateCards).where(eq(rateCards.id, standard!.id));
    }
  });

  it('非本地账号（issuer=github）→ 400 not_local_account', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow({ issuer: 'github' });
    const res = await request(`/v1/users/${userId}/set-password`, {
      token,
      body: { password: 'NewSecretPass1' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_local_account');
  });
});

describe('流水（wallet statement 单一真相）', () => {
  it('三条入金 newest-first + 余额链；v2 信封 {rows,total}（items 契约曾使前端流水恒空）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    for (let i = 0; i < 3; i += 1) {
      await fundUser(userId, '10');
    }
    const res = await request(`/v1/users/${userId}/transactions?page=1&page_size=50`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ amount: string; balanceAfter: string }>;
      total: number;
    };
    // v2 信封：前端 fetchAdminList 只读 data.rows/data.total——返回 items = 列表恒空
    expect(body.rows).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(new Decimal(body.rows[0]!.balanceAfter).eq(30)).toBe(true);
    expect(new Decimal(body.rows[2]!.balanceAfter).eq(10)).toBe(true);

    const bad = await request(`/v1/users/${userId}/transactions?from=notadate`, { token });
    expect(bad.status).toBe(400);
  });
});

describe('用户维度审计（AuditLogRow 完整形状——曾缺 adminSubject/targetType 致详情页两列空白）', () => {
  it('返回 targetType/targetId 与 admin 操作行的 adminSubject（join admins）', async () => {
    const { request } = buildTestApp();
    const { token, id: adminId } = await newAdmin();
    const userId = await newUserRow();
    // 管理员审计行（复刻 recordAudit 落库形状：adminId + targetType/targetId）
    const { auditLogs } = await import('@ai-gateway/db');
    await db.insert(auditLogs).values({
      adminId,
      actor: 'admin',
      action: 'user.gift',
      targetType: 'user',
      targetId: String(userId),
      detail: { amount: '1' },
    });
    const res = await request(`/v1/users/${userId}/audit-logs?page=1&page_size=20`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ action: string; targetType: string; targetId: string; actor: string; adminSubject: string | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThan(0);
    const giftRow = body.rows.find((r) => r.action === 'user.gift');
    expect(giftRow).toBeDefined();
    expect(giftRow!.targetType).toBe('user');
    expect(giftRow!.targetId).toBe(String(userId));
    expect(giftRow!.actor).toBe('admin');
    expect(giftRow!.adminSubject).toBe('test-admin'); // displayName 优先于 email
  });
});

describe('用户详情（profile 钱包富化——曾缺失致详情页余额/可用额度全空）', () => {
  it('详情返回完整钱包四字段与真实费率卡名（与列表页同口径）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    await fundUser(userId, '25.5');
    const [card] = await db.select({ id: rateCards.id, name: rateCards.name }).from(rateCards).limit(1);
    if (card) {
      await db.update(usersTable).set({ rateCardId: card.id }).where(eq(usersTable.id, userId));
    }
    const res = await request(`/v1/users/${userId}`, { token });
    expect(res.status).toBe(200);
    const profile = (await res.json()) as {
      balance: string;
      reservedBalance: string;
      availableBalance: string;
      creditLimit: string;
      rateCardName: string | null;
      identityProvider: string | null;
    };
    expect(new Decimal(profile.balance).eq('25.5')).toBe(true);
    expect(new Decimal(profile.availableBalance).eq('25.5')).toBe(true);
    expect(new Decimal(profile.reservedBalance).eq(0)).toBe(true);
    expect(typeof profile.identityProvider).toBe('string');
    if (card) expect(profile.rateCardName).toBe(card.name);
  });
});

describe('封禁语义', () => {
  it('封禁带原因（缺省「管理员封禁」）；解封清原因；freezeReason 不随非封禁', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();

    // freezeReason 只能随封禁
    const invalid = await request(`/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { freezeReason: '为什么' },
    });
    expect(invalid.status).toBe(400);

    // 封禁（缺省原因）
    await request(`/v1/users/${userId}`, { method: 'PATCH', token, body: { status: 1 } });
    let [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(row!.status).toBe(1);
    expect(row!.freezeReason).toBe('管理员封禁');

    // 解封清原因
    await request(`/v1/users/${userId}`, { method: 'PATCH', token, body: { status: 0 } });
    [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(row!.status).toBe(0);
    expect(row!.freezeReason).toBeNull();
  });
});

describe('调账与赠送（幂等 + 数值域）', () => {
  it('正数调账入账；负数调账扣款；Infinity/超上限 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();

    // '1e309' 字符串 coerce 出 Infinity → 400（防 numeric 溢出 500）
    const inf = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '1e309' },
    });
    expect(inf.status).toBe(400);
    // 超业务上限 → 400
    const over = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '1e10' },
    });
    expect(over.status).toBe(400);

    const plus = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '1' },
      headers: { 'idempotency-key': uid('adj') },
    });
    expect(plus.status).toBe(200);
    expect(new Decimal(((await plus.json()) as { balanceAfter: string }).balanceAfter).eq(1)).toBe(true);

    const minus = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '-0.5' },
      headers: { 'idempotency-key': uid('adj') },
    });
    expect(minus.status).toBe(200);
    expect(new Decimal(((await minus.json()) as { balanceAfter: string }).balanceAfter).eq(0.5)).toBe(true);
  });

  it('同 idempotency-key 重放：余额只动一次；异参同键 409', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const key = uid('idem');

    const first = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '5' },
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { replayed: boolean }).replayed).toBe(false);

    const replay = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '5' },
      headers: { 'idempotency-key': key },
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(true);

    const conflict = await request(`/v1/users/${userId}/adjust`, {
      token,
      body: { amount: '6' },
      headers: { 'idempotency-key': key },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('idempotency_conflict');

    // 余额 = 5（只动一次）
    const [funded] = await db.select({ subject: usersTable.subject }).from(usersTable).where(eq(usersTable.id, userId));
    const list = (await (
      await request(`/v1/users?q=${funded!.subject}`, { token })
    ).json()) as { rows: Array<{ subject: string; balance: string }> };
    const mine = list.rows.find((r) => r.subject === funded!.subject);
    expect(new Decimal(mine!.balance).eq(5)).toBe(true);
  });
});
