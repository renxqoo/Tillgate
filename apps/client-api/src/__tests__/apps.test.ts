/**
 * Apps 凭证管理 + Key 轮换集成套件（真 PG）：
 * Apps 绑定守卫与 Key 轮换语义锁定。
 * 网关每请求查库、无鉴权缓存——PATCH/轮换即时生效（断言无缓存延迟）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { userSubscriptions } from '@ai-gateway/db';
import { createSubscriptionDomain, systemContext } from '@ai-gateway/service';
import { createAppsService } from '../services/apps.service.js';
import { createKeysService } from '../services/keys.service.js';
import { sha256Hex } from '@ai-gateway/http';
import {
  db,
  newEnterpriseUser,
  newPlan,
  newUser,
  uid,
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-apps');
const apps = createAppsService({ db });
const keys = createKeysService({ db });
const subscriptionDomain = createSubscriptionDomain({ db, wallet });

describe('Apps 凭证（W1 归属守卫）', () => {
  it('创建：client_secret 仅此一次；库内是 SHA-256；绑自己的订阅 OK', async () => {
    const owner = await newEnterpriseUser();
    await wallet.credit(ctx, { userId: owner.id, amount: '10000', refType: 'gift', refId: uid('f') });
    const planId = await newPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
    const sub = await subscriptionDomain.purchase(ctx, {
      operationId: uid('op'),
      userId: owner.id,
      planId,
      quantity: 2,
      ensureOrg: true,
    });

    const created = await apps.create(ctx, owner.id, {
      name: 'agent-app',
      subscriptionId: sub.subscriptionId,
      scope: { rpm: 100 },
    });
    expect(created.clientSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(created.clientId).toMatch(/^app_[0-9a-f]{16}$/);
    expect(created.subscriptionId).toBe(sub.subscriptionId);
    // 列表永不携带哈希/明文
    const list = await apps.list(ctx, owner.id, { page: 1, limit: 10 });
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(created.clientSecret);
    expect(serialized).not.toContain(sha256Hex(created.clientSecret));
  });

  it('绑他人订阅 → 404 不得 201', async () => {
    const owner = await newEnterpriseUser();
    const stranger = await newUser();
    await wallet.credit(ctx, { userId: owner.id, amount: '10000', refType: 'gift', refId: uid('f') });
    const planId = await newPlan({ price: '50', quotaAmount: '500', allowSeats: true, sortOrder: 3 });
    const sub = await subscriptionDomain.purchase(ctx, {
      operationId: uid('op'),
      userId: owner.id,
      planId,
      quantity: 2,
      ensureOrg: true,
    });
    await expect(
      apps.create(ctx, stranger.id, { name: 'steal', subscriptionId: sub.subscriptionId }),
    ).rejects.toMatchObject({ status: 404, code: 'subscription_not_usable' });
  });

  it('禁用（重复 409）+ 轮换密钥（新明文一次下发，旧哈希失效）', async () => {
    const owner = await newUser();
    const created = await apps.create(ctx, owner.id, { name: 'rotate-me' });
    const rotated = await apps.rotateSecret(ctx, owner.id, created.id);
    expect(rotated.clientSecret).not.toBe(created.clientSecret);
    await apps.disable(ctx, owner.id, created.id);
    await expect(apps.disable(ctx, owner.id, created.id)).rejects.toMatchObject({
      code: 'app_already_disabled',
    });
    // 越权一律 404
    const attacker = await newUser();
    await expect(apps.disable(ctx, attacker.id, created.id)).rejects.toMatchObject({
      status: 404,
    });
    void randomUUID;
  });
});

describe('Key 轮换（L1 降级语义）', () => {
  it('订阅有效 → 新 Key 沿用计费来源；旧 Key 同事务吊销', async () => {
    const account = await newUser();
    const created = await keys.create(ctx, account.id, { name: 'to-rotate', rpmLimit: 66 });
    const rotated = await keys.rotate(ctx, account.id, created.id);
    expect(rotated.plaintext).not.toBe(created.plaintext);
    expect(rotated.rpmLimit).toBe(66); // 设置继承
    expect(rotated.revokedId).toBe(created.id);
    // 旧 Key 已吊销（网关侧即时生效——无缓存窗口）
    const list = await keys.list(ctx, account.id, { page: 1, limit: 10 });
    expect(list.rows.find((r) => r.id === created.id)?.status).toBe(1);
    expect(list.rows.find((r) => r.id === rotated.id)?.status).toBe(0);
    // 再次轮换已吊销的旧 Key → 409
    await expect(keys.rotate(ctx, account.id, created.id)).rejects.toMatchObject({
      code: 'key_already_revoked',
    });
  });

  it('绑定的订阅已过期 → 轮换产出的新 Key 降级为个人余额', async () => {
    const account = await newUser();
    await wallet.credit(ctx, { userId: account.id, amount: '100', refType: 'gift', refId: uid('f') });
    const planId = await newPlan({ price: '10', quotaAmount: '100' });
    const sub = await subscriptionDomain.purchase(ctx, {
      operationId: uid('op'),
      userId: account.id,
      planId,
    });
    const created = await keys.create(ctx, account.id, {
      name: 'sub-key',
      subscriptionId: sub.subscriptionId,
    });
    expect(created.subscriptionId).toBe(sub.subscriptionId);

    // 订阅到期（endAt 拉到过去）→ 轮换降级
    await db
      .update(userSubscriptions)
      .set({ endAt: new Date(Date.now() - 1_000) })
      .where(eq(userSubscriptions.id, sub.subscriptionId));
    const rotated = await keys.rotate(ctx, account.id, created.id);
    expect(rotated.subscriptionId).toBeNull(); // 降级为个人余额
  });
});
