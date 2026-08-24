/**
 * 竞态与清理分支(CAS 0 行的事务内判别、null 清空、异常形状):
 * 用 store 包装器强制触发内存替身正常路径到不了的 0 行分支——
 * 每个断言对应一个真实并发窗口(v1 语义:0 行 = 状态已变,按冲突表达)。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import { createAccountUseCases } from '../src/application/create-use-cases.js';
import { createTestHarness, type TestHarness } from '../src/testing/harness.js';
import type { AccountStorePort } from '../src/ports/account-store.js';

/** 以替身为底座覆写单个方法(仍写同一状态) */
function withStore<T>(
  h: TestHarness,
  override: (base: AccountStorePort) => Partial<AccountStorePort>,
  fn: (api: ReturnType<typeof createAccountUseCases>) => Promise<T>,
): Promise<T> {
  const store = Object.assign(Object.create(h.store) as AccountStorePort, override(h.store));
  const api = createAccountUseCases({ ...h.ctx, store });
  return fn(api);
}

describe('CAS 0 行的事务内判别(与预检并发的窗口)', () => {
  it('revokeKey:预检通过后 CAS 0 行 → key_already_revoked', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const { key } = await h.api.createKey({ userId: owner.id, name: 'k' });
    await withStore(
      h,
      (base) => ({
        revokeKey: async () =>
          (await base.findOwnedKey(base as never, { userId: owner.id, keyId: key.id })) && null,
      }),
      async (api) => {
        await expect(api.revokeKey({ userId: owner.id, keyId: key.id })).rejects.toMatchObject({
          code: 'accounts.key_already_revoked',
        });
      },
    );
  });

  it('patchKey:CAS 0 行 → key_already_revoked', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const { key } = await h.api.createKey({ userId: owner.id, name: 'k' });
    await withStore(
      h,
      () => ({ patchKey: async () => null }),
      async (api) => {
        await expect(
          api.patchKey({ userId: owner.id, keyId: key.id, patch: { name: 'x' } }),
        ).rejects.toMatchObject({
          code: 'accounts.key_already_revoked',
        });
      },
    );
  });

  it('rotateKey:旧 Key 吊销 0 行 → 回滚(新行不落库)', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const { key } = await h.api.createKey({ userId: owner.id, name: 'k' });
    const before = (await h.api.listKeys({ userId: owner.id })).total;
    await withStore(
      h,
      () => ({ revokeKey: async () => null }),
      async (api) => {
        await expect(api.rotateKey({ userId: owner.id, keyId: key.id })).rejects.toMatchObject({
          code: 'accounts.key_already_revoked',
        });
      },
    );
    expect((await h.api.listKeys({ userId: owner.id })).total).toBe(before); // 新行已回滚
  });

  it('disableApp/rotateAppSecret:CAS 0 行 → app_already_disabled', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const { app } = await h.api.createApp({ userId: owner.id, name: 'x' });
    await withStore(
      h,
      () => ({ disableApp: async () => null }),
      async (api) => {
        await expect(api.disableApp({ userId: owner.id, appId: app.id })).rejects.toMatchObject({
          code: 'accounts.app_already_disabled',
        });
      },
    );
    await withStore(
      h,
      () => ({ rotateAppSecret: async () => null }),
      async (api) => {
        await expect(
          api.rotateAppSecret({ userId: owner.id, appId: app.id }),
        ).rejects.toMatchObject({
          code: 'accounts.app_already_disabled',
        });
      },
    );
  });

  it('acceptInvitation:翻转 0 行(并发赢家已消费)→ invitation_invalid 回滚成员行', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 1, email: 'o@x.io' });
    const org = h.store.seed.org({ ownerUserId: owner.id });
    h.store.seed.member({ orgId: org.id, userId: owner.id, role: 'owner' });
    h.store.seed.subscription({ userId: owner.id, orgId: org.id, quantity: 5 });
    const acceptor = h.store.seed.user({ id: 2, email: 'a@x.io' });
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'a@x.io',
    });
    await withStore(
      h,
      () => ({ acceptInvitation: async () => false }),
      async (api) => {
        await expect(
          api.acceptInvitation({ token: inv.token, acceptorUserId: acceptor.id }),
        ).rejects.toMatchObject({
          code: 'accounts.invitation_invalid',
        });
      },
    );
    expect(await h.store.countActiveMembers(h.ctx.db, org.id)).toBe(1); // insertOrRevive 已回滚
  });

  it('provisionOAuthAccount:插入撞唯一键 → exists 分支回查(23505 兜底)', async () => {
    const h = createTestHarness();
    const existing = h.store.seed.user({ issuer: 'github', subject: 'gh-1' });
    await withStore(
      h,
      () => ({ insertOAuthUser: async () => ({ status: 'exists' as const }) }),
      async (api) => {
        const r = await api.provisionOAuthAccount({ issuer: 'github', subject: 'gh-1' });
        expect(r.created).toBe(false);
        expect(r.user.id).toBe(existing.id);
      },
    );
  });
});

describe('清理分支与异常形状', () => {
  it('acceptInvitation:接受者账号不存在 → user_not_found', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 1, email: 'o@x.io' });
    const org = h.store.seed.org({ ownerUserId: owner.id });
    h.store.seed.member({ orgId: org.id, userId: owner.id, role: 'owner' });
    h.store.seed.subscription({ userId: owner.id, orgId: org.id, quantity: 5 });
    const inv = await h.api.inviteMember({
      orgId: org.id,
      operatorUserId: owner.id,
      email: 'ghost@x.io',
    });
    await expect(
      h.api.acceptInvitation({ token: inv.token, acceptorUserId: 999 }),
    ).rejects.toMatchObject({
      code: 'accounts.user_not_found',
    });
  });

  it('getOrgDetail:成员行存在但组织已不存在 → org_not_found', async () => {
    const h = createTestHarness();
    const member = h.store.seed.user({});
    h.store.seed.member({ orgId: 424242, userId: member.id }); // org 不存在
    await expect(h.api.getOrgDetail({ userId: member.id, orgId: 424242 })).rejects.toMatchObject({
      code: 'accounts.org_not_found',
    });
  });

  it('patchKey:null 清空限额/备注;过去 expiresAt 拒绝', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const { key } = await h.api.createKey({
      userId: owner.id,
      name: 'k',
      remark: 'r',
      rpmLimit: 10,
      tpmLimit: 20,
      dailySpendLimit: '1',
    });
    const cleared = await h.api.patchKey({
      userId: owner.id,
      keyId: key.id,
      patch: {
        remark: null,
        rpmLimit: null,
        tpmLimit: null,
        dailySpendLimit: null,
        expiresAt: null,
      },
    });
    expect(cleared.remark).toBeNull();
    expect(cleared.rpmLimit).toBeNull();
    expect(cleared.tpmLimit).toBeNull();
    expect(cleared.dailySpendLimit).toBeNull();
    expect(cleared.expiresAt).toBeNull();
    await expect(
      h.api.patchKey({ userId: owner.id, keyId: key.id, patch: { remark: 'x'.repeat(256) } }),
    ).rejects.toMatchObject({ code: 'accounts.key_patch_invalid' });
    await expect(
      h.api.patchKey({
        userId: owner.id,
        keyId: key.id,
        patch: { expiresAt: new Date(h.ctx.now().getTime() - 1) },
      }),
    ).rejects.toMatchObject({ code: 'accounts.key_patch_invalid' });
  });

  it('adminPatchUser:null 清空(卡/限额/封禁原因显式空)', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({
      email: 'keep@x.io',
      rateCardId: h.store.seed.rateCard({}).id,
      rpmLimit: 5,
      tpmLimit: 6,
    });
    const patched = await h.api.adminPatchUser({
      userId: owner.id,
      patch: { rateCardId: null, rpmLimit: null, tpmLimit: null, email: null },
      adminId: 1,
    });
    expect(patched.rateCardId).toBeNull();
    expect(patched.rpmLimit).toBeNull();
    expect(patched.tpmLimit).toBeNull();
    expect(patched.email).not.toBeNull(); // email null = 不改(变更须显式传值)
    const explicitNullReason = await h.api.adminPatchUser({
      userId: owner.id,
      patch: { status: 1, freezeReason: null },
      adminId: 1,
    });
    expect(explicitNullReason.freezeReason).toBeNull(); // 显式空覆盖缺省原因
  });

  it('setMemberLimits:monthlyQuota 域校验与 null 清空', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 1 });
    const org = h.store.seed.org({ ownerUserId: owner.id });
    h.store.seed.member({ orgId: org.id, userId: owner.id, role: 'owner' });
    const member = h.store.seed.user({ id: 2 });
    h.store.seed.member({ orgId: org.id, userId: member.id, monthlyQuota: '5' });
    await expect(
      h.api.setMemberLimits({
        orgId: org.id,
        operatorUserId: owner.id,
        memberUserId: member.id,
        monthlyQuota: '1e9',
      }),
    ).rejects.toMatchObject({ code: 'accounts.member_limits_invalid' });
    const cleared = await h.api.setMemberLimits({
      orgId: org.id,
      operatorUserId: owner.id,
      memberUserId: member.id,
      monthlyQuota: null,
    });
    expect(cleared.monthlyQuota).toBeNull();
  });

  it('adminListKeys:asc 排序分支', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    await h.api.createKey({ userId: owner.id, name: 'b' });
    await h.api.createKey({ userId: owner.id, name: 'a' });
    const asc = await h.api.adminListKeys({ sort: 'name', order: 'asc' });
    expect(defined(asc.rows[0], 'asc.rows[0]').name).toBe('a');
    const desc = await h.api.adminListKeys({ sort: 'name', order: 'desc' });
    expect(defined(desc.rows[0], 'desc.rows[0]').name).toBe('b');
  });

  it('onboarding:非 Error 形状的失败 → code unknown(不抛)', async () => {
    const h = createTestHarness();
    h.store.seed.user({ id: 2 });
    h.store.seed.marketing({ signupGiftAmount: '1' });
    h.wallet.credit = async () => {
      throw 'string-error'; // 非 Error 形状
    };
    const report = await h.api.completeAccountOnboarding({ userId: 2 });
    expect(report.gift).toEqual({ status: 'failed', code: 'unknown' });
  });
});
