/**
 * API Key 用例(MIGRATION §1.3):明文一次、限额域、订阅守卫、CAS 生命周期、
 * 轮换继承与降级、网关鉴权读模型、越权=not_found、哈希零泄漏。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import { sha256Hex } from '../src/domain/credentials.js';
import { createTestHarness } from '../src/testing/harness.js';

/** 旧测试红线:任何响应形状不出现 64 位 hex 哈希 */
const HEX64 = /\b[0-9a-f]{64}\b/;

function seeded() {
  const h = createTestHarness();
  const owner = h.store.seed.user({ id: 100, email: 'owner@x.io' });
  const stranger = h.store.seed.user({ id: 200, email: 'stranger@x.io' });
  return { h, owner, stranger };
}

describe('createKey', () => {
  it('明文 sk_+40hex 仅一次;库内 SHA-256 与网关 resolve 同口径;preview 脱敏', async () => {
    const { h, owner } = seeded();
    const { key, plaintext } = await h.api.createKey({ userId: owner.id, name: 'prod' });
    expect(plaintext).toMatch(/^sk_[0-9a-f]{40}$/);
    expect(key.name).toBe('prod');
    expect(JSON.stringify(key)).not.toMatch(HEX64);
    expect(key.keyPreview).toBe(`sk_****${plaintext.slice(-4)}`);
    const resolved = await h.api.resolveKeyByHash(sha256Hex(plaintext));
    expect(resolved).not.toBeNull();
    expect(defined(resolved, 'resolved').keyId).toBe(key.id);
    expect(defined(resolved, 'resolved').userId).toBe(owner.id);
  });

  it('限额字段透传落库;域校验拒绝', async () => {
    const { h, owner } = seeded();
    const { key } = await h.api.createKey({
      userId: owner.id,
      name: 'k',
      rpmLimit: 600,
      tpmLimit: 90_000,
      dailySpendLimit: '12.34',
    });
    expect(key.rpmLimit).toBe(600);
    expect(key.tpmLimit).toBe(90_000);
    expect(key.dailySpendLimit).toBe('12.34');
    await expect(
      h.api.createKey({ userId: owner.id, name: 'k', dailySpendLimit: '1e21' }),
    ).rejects.toMatchObject({ code: 'accounts.key_patch_invalid' });
    await expect(
      h.api.createKey({ userId: owner.id, name: 'k', rpmLimit: 1_000_001 }),
    ).rejects.toMatchObject({
      code: 'accounts.key_patch_invalid',
    });
    await expect(h.api.createKey({ userId: owner.id, name: '' })).rejects.toMatchObject({
      code: 'accounts.key_patch_invalid',
    });
    await expect(
      h.api.createKey({ userId: owner.id, name: 'k', expiresAt: new Date('2020-01-01T00:00:00Z') }),
    ).rejects.toMatchObject({ code: 'accounts.key_patch_invalid' });
  });

  it('订阅归属守卫:本人订阅可用;他人订阅/不存在 → subscription_not_usable(不泄漏)', async () => {
    const { h, owner, stranger } = seeded();
    const own = h.store.seed.subscription({ id: 300, userId: owner.id });
    const other = h.store.seed.subscription({ id: 301, userId: stranger.id });
    const ok = await h.api.createKey({ userId: owner.id, name: 'k', subscriptionId: own.id });
    expect(ok.key.subscriptionId).toBe(300);
    await expect(
      h.api.createKey({ userId: owner.id, name: 'k', subscriptionId: other.id }),
    ).rejects.toMatchObject({
      code: 'accounts.subscription_not_usable',
    });
    await expect(
      h.api.createKey({ userId: owner.id, name: 'k', subscriptionId: 999 }),
    ).rejects.toMatchObject({
      code: 'accounts.subscription_not_usable',
    });
  });
});

describe('listKeys / patchKey / revokeKey', () => {
  it('列表分页 + 哈希零出现', async () => {
    const { h, owner } = seeded();
    await h.api.createKey({ userId: owner.id, name: 'a' });
    await h.api.createKey({ userId: owner.id, name: 'b' });
    const page = await h.api.listKeys({ userId: owner.id, page: 1, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(1);
    expect(JSON.stringify(page)).not.toMatch(HEX64);
  });

  it('patch:越权/不存在 → key_not_found;已吊销 → key_already_revoked;成功即时生效', async () => {
    const { h, owner, stranger } = seeded();
    const { key } = await h.api.createKey({ userId: owner.id, name: 'a' });
    await expect(
      h.api.patchKey({ userId: stranger.id, keyId: key.id, patch: { name: 'x' } }),
    ).rejects.toMatchObject({
      code: 'accounts.key_not_found',
    });
    const patched = await h.api.patchKey({
      userId: owner.id,
      keyId: key.id,
      patch: { name: 'renamed', rpmLimit: 99 },
    });
    expect(patched.name).toBe('renamed');
    await h.api.revokeKey({ userId: owner.id, keyId: key.id });
    await expect(
      h.api.patchKey({ userId: owner.id, keyId: key.id, patch: { name: 'y' } }),
    ).rejects.toMatchObject({
      code: 'accounts.key_already_revoked',
    });
  });

  it('revoke:CAS 一次;重复 → key_already_revoked;吊销后网关 resolve 立即 miss(无缓存承诺)', async () => {
    const { h, owner } = seeded();
    const { key, plaintext } = await h.api.createKey({ userId: owner.id, name: 'a' });
    const revoked = await h.api.revokeKey({ userId: owner.id, keyId: key.id });
    expect(revoked.status).toBe(1);
    expect(revoked.revokedAt).not.toBeNull();
    await expect(h.api.revokeKey({ userId: owner.id, keyId: key.id })).rejects.toMatchObject({
      code: 'accounts.key_already_revoked',
    });
    expect(await h.api.resolveKeyByHash(sha256Hex(plaintext))).toBeNull();
  });
});

describe('rotateKey', () => {
  it('继承全部设置;同事务吊销旧 Key;新明文可用、旧哈希即刻失效', async () => {
    const { h, owner } = seeded();
    const { key, plaintext } = await h.api.createKey({
      userId: owner.id,
      name: 'a',
      remark: 'r',
      rpmLimit: 120,
      dailySpendLimit: '5',
    });
    const rotated = await h.api.rotateKey({ userId: owner.id, keyId: key.id });
    expect(rotated.plaintext).not.toBe(plaintext);
    expect(rotated.key.rpmLimit).toBe(120);
    expect(rotated.key.remark).toBe('r');
    expect(rotated.key.dailySpendLimit).toBe('5');
    const resolvedNew = await h.api.resolveKeyByHash(sha256Hex(rotated.plaintext));
    expect(defined(resolvedNew, 'resolvedNew').keyId).toBe(rotated.key.id);
    expect(await h.api.resolveKeyByHash(sha256Hex(plaintext))).toBeNull();
    // 再轮换已吊销旧 Key → 409
    await expect(h.api.rotateKey({ userId: owner.id, keyId: key.id })).rejects.toMatchObject({
      code: 'accounts.key_already_revoked',
    });
  });

  it('绑定订阅失格(过期)→ 轮换降级个人余额 subscriptionId=null', async () => {
    const { h, owner } = seeded();
    const teamSub = h.store.seed.subscription({ id: 300, userId: owner.id });
    const { key } = await h.api.createKey({
      userId: owner.id,
      name: 'a',
      subscriptionId: teamSub.id,
    });
    // 订阅过期(时钟推进到 endAt 之后)
    h.advanceClockMs(31 * 86_400_000);
    const rotated = await h.api.rotateKey({ userId: owner.id, keyId: key.id });
    expect(rotated.key.subscriptionId).toBeNull();
  });

  it('owner 被封禁 → resolve miss(join users.status 守卫)', async () => {
    const { h, owner } = seeded();
    const { plaintext } = await h.api.createKey({ userId: owner.id, name: 'a' });
    const hash = sha256Hex(plaintext);
    expect(await h.api.resolveKeyByHash(hash)).not.toBeNull();
    h.store.seed.user({ id: owner.id, status: 1 }); // 覆写为封禁
    expect(await h.api.resolveKeyByHash(hash)).toBeNull();
  });

  it('过期 Key → resolve miss(存储时钟)', async () => {
    const { h, owner } = seeded();
    const { plaintext } = await h.api.createKey({
      userId: owner.id,
      name: 'a',
      expiresAt: new Date(h.ctx.now().getTime() + 1_000), // 以 harness 时钟为参照的未来
    });
    const hash = sha256Hex(plaintext);
    expect(await h.api.resolveKeyByHash(hash)).not.toBeNull();
    h.advanceClockMs(2_000);
    expect(await h.api.resolveKeyByHash(hash)).toBeNull();
  });
});

describe('adminListKeys / adminPatchKey / rebindSubscription', () => {
  it('q 命中 Key 名与属主邮箱;status 翻转合法枚举;非法枚举拒绝;审计落库', async () => {
    const { h, owner } = seeded();
    await h.api.createKey({ userId: owner.id, name: 'alpha-key' });
    const byEmail = await h.api.adminListKeys({ q: 'owner@x.io' });
    expect(byEmail.total).toBe(1);
    const byName = await h.api.adminListKeys({ q: 'alpha-key' });
    expect(byName.total).toBe(1);
    const keyId = defined(byName.rows[0], 'byName.rows[0]').id;

    const flipped = await h.api.adminPatchKey({ keyId, patch: { status: 1 }, adminId: 5 });
    expect(flipped.status).toBe(1);
    const restored = await h.api.adminPatchKey({ keyId, patch: { status: 0 }, adminId: 5 });
    expect(restored.status).toBe(0);
    await expect(
      h.api.adminPatchKey({ keyId, patch: { status: 99 }, adminId: 5 }),
    ).rejects.toMatchObject({
      code: 'accounts.key_patch_invalid',
    });
    await expect(
      h.api.adminPatchKey({ keyId: 999, patch: { name: 'x' }, adminId: 5 }),
    ).rejects.toMatchObject({
      code: 'accounts.key_not_found',
    });
    expect(h.audit.actions.at(-1)).toMatchObject({ action: 'api_key.update', adminId: 5 });
    expect(JSON.stringify(restored)).not.toMatch(HEX64);
  });

  it('rebindSubscription:旧订阅绑定的 Key/App 改绑新订阅(续费换绑)', async () => {
    const { h, owner } = seeded();
    h.store.seed.subscription({ id: 300, userId: owner.id });
    const { key } = await h.api.createKey({ userId: owner.id, name: 'k', subscriptionId: 300 });
    const app = h.store.seed.app({ userId: owner.id, subscriptionId: 300 });
    const result = await h.api.rebindSubscription({
      fromSubscriptionId: 300,
      toSubscriptionId: 301,
    });
    expect(result).toEqual({ keys: 1, apps: 1 });
    expect(
      defined(
        await h.store.findOwnedKey(h.ctx.db, { userId: owner.id, keyId: key.id }),
        'findOwnedKey',
      ).subscriptionId,
    ).toBe(301);
    expect(
      defined(
        await h.store.findOwnedApp(h.ctx.db, { userId: owner.id, appId: app.id }),
        'findOwnedApp',
      ).subscriptionId,
    ).toBe(301);
  });
});
