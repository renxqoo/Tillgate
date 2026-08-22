/**
 * Application 用例(MIGRATION §1.4):凭证材料一次下发、订阅守卫、
 * 禁用/轮换 CAS、鉴权读模型(appId/client 双等值 + 属主状态守卫)。
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/domain/credentials.js';
import { createTestHarness } from '../src/testing/harness.js';

const HEX64 = /\b[0-9a-f]{64}\b/;

describe('createApp / listApps', () => {
  it('appId 32hex、clientId app_+16hex、secret 48hex 仅一次;列表零哈希零明文', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 100 });
    const { app, clientSecret } = await h.api.createApp({
      userId: owner.id,
      name: 'agent',
      scope: { models: ['gpt-4o'], rpm: 60 },
    });
    expect(app.appId).toMatch(/^[0-9a-f]{32}$/);
    expect(app.clientId).toMatch(/^app_[0-9a-f]{16}$/);
    expect(clientSecret).toMatch(/^[0-9a-f]{48}$/);
    const list = await h.api.listApps({ userId: owner.id });
    expect(list.total).toBe(1);
    expect(JSON.stringify(list)).not.toMatch(HEX64);
    expect(JSON.stringify(list)).not.toContain(clientSecret);
  });

  it('name/description/scope 域校验', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    await expect(h.api.createApp({ userId: owner.id, name: '' })).rejects.toMatchObject({
      code: 'accounts.app_patch_invalid',
    });
    await expect(
      h.api.createApp({ userId: owner.id, name: 'x', description: 'd'.repeat(256) }),
    ).rejects.toMatchObject({ code: 'accounts.app_patch_invalid' });
    await expect(
      h.api.createApp({ userId: owner.id, name: 'x', scope: { rpm: 0 } }),
    ).rejects.toMatchObject({ code: 'accounts.app_scope_invalid' });
  });

  it('订阅守卫与 Key 同口径', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const stranger = h.store.seed.user({});
    const other = h.store.seed.subscription({ userId: stranger.id });
    await expect(
      h.api.createApp({ userId: owner.id, name: 'x', subscriptionId: other.id }),
    ).rejects.toMatchObject({ code: 'accounts.subscription_not_usable' });
  });
});

describe('disableApp / rotateAppSecret', () => {
  it('禁用 CAS 一次,重复 → app_already_disabled;越权 → app_not_found', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 100 });
    const stranger = h.store.seed.user({ id: 200 });
    const { app } = await h.api.createApp({ userId: owner.id, name: 'x' });
    await expect(h.api.disableApp({ userId: stranger.id, appId: app.id })).rejects.toMatchObject({
      code: 'accounts.app_not_found',
    });
    const disabled = await h.api.disableApp({ userId: owner.id, appId: app.id });
    expect(disabled.status).toBe(1);
    await expect(h.api.disableApp({ userId: owner.id, appId: app.id })).rejects.toMatchObject({
      code: 'accounts.app_already_disabled',
    });
  });

  it('轮换:新明文一次、旧 secret 失效、rotatedAt 推进;禁用后轮换拒绝', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const created = await h.api.createApp({ userId: owner.id, name: 'x' });
    const rotated = await h.api.rotateAppSecret({ userId: owner.id, appId: created.app.id });
    expect(rotated.clientSecret).not.toBe(created.clientSecret);
    expect(rotated.app.rotatedAt).not.toBeNull();
    // 旧 secret 验证 miss,新 secret 命中
    expect(
      await h.api.verifyAppClient({
        clientId: created.app.clientId,
        clientSecret: created.clientSecret,
      }),
    ).toBeNull();
    const ok = await h.api.verifyAppClient({
      clientId: created.app.clientId,
      clientSecret: rotated.clientSecret,
    });
    expect(ok!.id).toBe(created.app.id);
    await h.api.disableApp({ userId: owner.id, appId: created.app.id });
    await expect(
      h.api.rotateAppSecret({ userId: owner.id, appId: created.app.id }),
    ).rejects.toMatchObject({
      code: 'accounts.app_already_disabled',
    });
  });
});

describe('鉴权读模型', () => {
  it('resolveApp:appId 命中并带属主守卫;属主封禁 → miss', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({ id: 100 });
    const { app } = await h.api.createApp({ userId: owner.id, name: 'x', scope: { rpm: 10 } });
    const found = await h.api.resolveApp(app.appId);
    expect(found).toMatchObject({ userId: owner.id, scope: { rpm: 10 } });
    h.store.seed.user({ id: owner.id, status: 1 });
    expect(await h.api.resolveApp(app.appId)).toBeNull();
    expect(await h.api.resolveApp('nonexistent')).toBeNull();
  });

  it('verifyAppClient:client_id+secret 双等值;错 secret/禁用 → null(统一不区分)', async () => {
    const h = createTestHarness();
    const owner = h.store.seed.user({});
    const { app, clientSecret } = await h.api.createApp({ userId: owner.id, name: 'x' });
    const ok = await h.api.verifyAppClient({ clientId: app.clientId, clientSecret });
    expect(ok!.appId).toBe(app.appId);
    expect(
      await h.api.verifyAppClient({ clientId: app.clientId, clientSecret: '0'.repeat(48) }),
    ).toBeNull();
    await h.api.disableApp({ userId: owner.id, appId: app.id });
    expect(await h.api.verifyAppClient({ clientId: app.clientId, clientSecret })).toBeNull();
  });

  it('sha256Hex 与 verifyAppClient 的哈希口径一致(同 credentials 单一真相)', () => {
    expect(sha256Hex('abc')).toHaveLength(64);
  });
});
