/**
 * 资料与管理面用户用例(MIGRATION §1.1-3..7):profile、显示名、列表过滤、
 * 管理补丁全矩阵(freezeReason 规则/锚推进/换卡守卫/限额域/审计)。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import { createTestHarness } from '../src/testing/harness.js';

describe('getProfile / updateDisplayName', () => {
  it('profile 含费率卡名;无行 → user_not_found', async () => {
    const h = createTestHarness();
    const card = h.store.seed.rateCard({ id: 11, name: '标准' });
    const u = h.store.seed.user({ email: 'a@x.io', rateCardId: card.id });
    const p = await h.api.getProfile(u.id);
    expect(p.rateCardName).toBe('标准');
    await expect(h.api.getProfile(999)).rejects.toMatchObject({ code: 'accounts.user_not_found' });
  });

  it('改显示名 trim 落库;空名拒绝;无行 404', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({ displayName: 'old' });
    const updated = await h.api.updateDisplayName({ userId: u.id, displayName: '  新名  ' });
    expect(updated.displayName).toBe('新名');
    await expect(
      h.api.updateDisplayName({ userId: u.id, displayName: '   ' }),
    ).rejects.toMatchObject({
      code: 'accounts.display_name_invalid',
    });
    await expect(h.api.updateDisplayName({ userId: 999, displayName: 'x' })).rejects.toMatchObject({
      code: 'accounts.user_not_found',
    });
  });
});

describe('adminListUsers', () => {
  it('q 模糊命中 subject/email/displayName;status/enterprise 过滤;分页', async () => {
    const h = createTestHarness();
    h.store.seed.user({ id: 1, subject: 'alpha@x.io', email: 'alpha@x.io', displayName: '甲' });
    h.store.seed.user({
      id: 2,
      subject: 'beta@x.io',
      email: 'beta@x.io',
      displayName: '乙',
      status: 1,
    });
    h.store.seed.user({
      id: 3,
      subject: 'gamma@y.io',
      email: 'gamma@y.io',
      displayName: '丙',
      isEnterprise: true,
    });

    const q = await h.api.adminListUsers({ q: 'x.io' });
    expect(q.total).toBe(2);
    const banned = await h.api.adminListUsers({ status: 1 });
    expect(banned.total).toBe(1);
    expect(defined(banned.rows[0], 'banned.rows[0]').id).toBe(2);
    const ent = await h.api.adminListUsers({ enterprise: true });
    expect(ent.rows.map((r) => r.id)).toEqual([3]);
    const page = await h.api.adminListUsers({ page: 1, limit: 2 });
    expect(page.rows).toHaveLength(2);
    // 默认排序 id desc(v1 desc(id) 稳定序)
    const all = await h.api.adminListUsers({ limit: 10 });
    expect(all.rows.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('回归(列表费率卡列显示—):行投影携带绑定费率卡名,与详情同口径', async () => {
    const h = createTestHarness();
    const card = h.store.seed.rateCard({ id: 7, name: '企业卡' });
    h.store.seed.user({ id: 1, subject: 'bound@x.io', rateCardId: card.id });
    h.store.seed.user({ id: 2, subject: 'free@x.io', rateCardId: null });

    const page = await h.api.adminListUsers({ limit: 10 });
    const bound = defined(page.rows.find((r) => r.id === 1), 'bound row');
    const free = defined(page.rows.find((r) => r.id === 2), 'free row');
    expect(bound.rateCardName).toBe('企业卡');
    expect(free.rateCardName).toBeNull();
  });

  it('排序白名单外的字段回落默认;非法分页回落缺省(policy 注入)', async () => {
    const h = createTestHarness();
    const r = await h.api.adminListUsers({
      sort: 'passwordHash;drop',
      order: 'asc',
      page: -1,
      limit: 9999,
    });
    expect(r.rows).toEqual([]);
  });
});

describe('adminPatchUser', () => {
  it('封禁:缺省原因注入 policy.banDefaultReason;解封清原因', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({});
    const banned = await h.api.adminPatchUser({ userId: u.id, patch: { status: 1 }, adminId: 5 });
    expect(banned.status).toBe(1);
    expect(banned.freezeReason).toBe('管理员封禁'); // v1 等价值(policy 注入)
    const unbanned = await h.api.adminPatchUser({ userId: u.id, patch: { status: 0 }, adminId: 5 });
    expect(unbanned.freezeReason).toBeNull();
  });

  it('freezeReason 只能随封禁出现(v1 superRefine 语义)', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({});
    await expect(
      h.api.adminPatchUser({ userId: u.id, patch: { freezeReason: '违规' }, adminId: 5 }),
    ).rejects.toMatchObject({ code: 'accounts.user_patch_invalid' });
    await expect(
      h.api.adminPatchUser({ userId: u.id, patch: { status: 0, freezeReason: 'x' }, adminId: 5 }),
    ).rejects.toMatchObject({ code: 'accounts.user_patch_invalid' });
    const withReason = await h.api.adminPatchUser({
      userId: u.id,
      patch: { status: 1, freezeReason: ' 刷单 ' },
      adminId: 5,
    });
    expect(withReason.freezeReason).toBe('刷单');
  });

  it('email 变更同事务推进 identity 吊销线(§3.4 唯一所有者;port 调用语义)', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({ email: 'old@x.io' });
    expect(h.sessionInvalidation.calls).toHaveLength(0);
    const updated = await h.api.adminPatchUser({
      userId: u.id,
      patch: { email: 'New@X.io' },
      adminId: 5,
    });
    expect(updated.email).toBe('new@x.io');
    // port 恰好被调一次,user realm(吊销唯一真相 = identity anchors,旧列已随 0090 退役)
    expect(h.sessionInvalidation.calls).toEqual([{ realm: 'user', userId: u.id }]);
  });

  it('非 email 变更不触发会话失效', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({});
    await h.api.adminPatchUser({ userId: u.id, patch: { displayName: 'n' }, adminId: 5 });
    expect(h.sessionInvalidation.calls).toHaveLength(0);
  });

  it('会话失效 bridge 失败随业务事务回滚(§5.4:email 变更与吊销原子)', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({ email: 'rollback@x.io' });
    const before = await h.store.findUserById(h.ctx.db, u.id);
    const boom: typeof h.sessionInvalidation = {
      ...h.sessionInvalidation,
      async invalidateUserSessions() {
        throw new Error('identity anchor unavailable');
      },
    };
    (h.ctx as unknown as { sessionInvalidation: typeof boom }).sessionInvalidation = boom;
    await expect(
      h.api.adminPatchUser({ userId: u.id, patch: { email: 'New2@X.io' }, adminId: 5 }),
    ).rejects.toThrow('identity anchor unavailable');
    // 业务写入一并回滚(内存替身经快照回滚 fake db)
    const after = await h.store.findUserById(h.ctx.db, u.id);
    expect(defined(after, 'after').email).toBe(defined(before, 'before').email);
  });

  it('换卡守卫两分:不存在 → rate_card_not_found;停用 → rate_card_disabled', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({});
    h.store.seed.rateCard({ id: 7, status: 1 });
    await expect(
      h.api.adminPatchUser({ userId: u.id, patch: { rateCardId: 99 }, adminId: 5 }),
    ).rejects.toMatchObject({
      code: 'accounts.rate_card_not_found',
    });
    await expect(
      h.api.adminPatchUser({ userId: u.id, patch: { rateCardId: 7 }, adminId: 5 }),
    ).rejects.toMatchObject({
      code: 'accounts.rate_card_disabled',
    });
    const ok = await h.api.adminPatchUser({
      userId: u.id,
      patch: { rateCardId: h.store.seed.rateCard({}).id },
      adminId: 5,
    });
    expect(ok.rateCardId).not.toBeNull();
  });

  it.each([
    [{ status: 9 }, 'user_patch_invalid'],
    [{ rpmLimit: 0 }, 'user_patch_invalid'],
    [{ tpmLimit: 1_000_000_001 }, 'user_patch_invalid'],
    [{ dailySpendLimit: '1e21' }, 'user_patch_invalid'],
    [{ dailySpendLimit: '-1' }, 'user_patch_invalid'],
    [{ displayName: 'x'.repeat(65) }, 'display_name_invalid'],
    [{ email: 'bad' }, 'email_invalid'],
  ])('patch %j 拒绝为 %s', async (patch, code) => {
    const h = createTestHarness();
    const u = h.store.seed.user({});
    await expect(h.api.adminPatchUser({ userId: u.id, patch, adminId: 5 })).rejects.toMatchObject({
      code: `accounts.${code}`,
    });
  });

  it('dailySpendLimit=0 在管理面合法(v1 非负口径);null 清空', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({});
    const zero = await h.api.adminPatchUser({
      userId: u.id,
      patch: { dailySpendLimit: '0' },
      adminId: 5,
    });
    expect(zero.dailySpendLimit).toBe('0');
    const cleared = await h.api.adminPatchUser({
      userId: u.id,
      patch: { dailySpendLimit: null },
      adminId: 5,
    });
    expect(cleared.dailySpendLimit).toBeNull();
  });

  it('目标不存在 → user_not_found;审计 user.update 同事务落库', async () => {
    const h = createTestHarness();
    await expect(
      h.api.adminPatchUser({ userId: 999, patch: { status: 1 }, adminId: 5 }),
    ).rejects.toMatchObject({
      code: 'accounts.user_not_found',
    });
    await h.api.adminPatchUser({
      userId: h.store.seed.user({}).id,
      patch: { isEnterprise: true },
      adminId: 5,
    });
    expect(h.audit.actions).toHaveLength(1);
    expect(h.audit.actions[0]).toMatchObject({
      actor: 'admin',
      adminId: 5,
      action: 'user.update',
      targetType: 'user',
    });
  });

  it('adminGetUser 无行 404;读数探针直通', async () => {
    const h = createTestHarness();
    const u = h.store.seed.user({ isEnterprise: true, rateCardId: h.store.seed.rateCard({}).id });
    await expect(h.api.adminGetUser(999)).rejects.toMatchObject({
      code: 'accounts.user_not_found',
    });
    expect(await h.api.adminGetUser(u.id)).toMatchObject({ isEnterprise: true });
    expect(await h.api.userExists(u.id)).toBe(true);
    expect(await h.api.userExists(999)).toBe(false);
    expect(await h.api.userIsEnterprise(u.id)).toBe(true);
    expect(await h.api.userRateCardBinding(u.id)).not.toBeNull();
    expect(await h.api.userRateCardBinding(999)).toBeNull();
  });
});
