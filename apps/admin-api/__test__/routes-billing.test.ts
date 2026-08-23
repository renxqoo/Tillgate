import { describe, expect, it, vi } from 'vitest';
import { BillingErrors } from '@tokenlens/billing';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

/**
 * 订阅动词契约（v1 subscriptions.test.ts 行为规格）:管理面 userId:null 直续 /
 * 幂等键透传 / 资金动词 409 冲突透传（billing.idempotency_conflict）。
 */

describe('POST /v1/subscriptions/:id/*', () => {
  it('renew:userId null(管理面免属主检查) + operationId 透传', async () => {
    const renew = vi.fn(async () => ({
      userId: 42,
      subscriptionId: 5,
      planId: 1,
      planName: '标准',
      quantity: 1,
    })) as never;
    const app = createAdminApp(fakeDeps({ subscriptions: { renew } }));
    const res = await app.request('/v1/subscriptions/5/renew', {
      method: 'POST',
      headers: { ...authHeader(), 'idempotency-key': 'rn-1' },
    });
    expect(res.status).toBe(200);
    expect(renew).toHaveBeenCalledWith({ operationId: 'rn-1', userId: null, subscriptionId: 5 });
  });

  it('change:quantity 缺省 1;grant:packId = 路径 id', async () => {
    const change = vi.fn(async () => ({ subscriptionId: 5 })) as never;
    const grantPack = vi.fn(async () => ({
      userId: 9,
      subscriptionId: 5,
      quotaAdded: '10',
      balanceBefore: '0',
      balanceAfter: '10',
      replayed: false,
    })) as never;
    const app = createAdminApp(fakeDeps({ subscriptions: { change, grantPack } }));
    await app.request('/v1/subscriptions/5/change', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ targetPlanId: 2 }),
    });
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 5, targetPlanId: 2, quantity: 1, userId: null }),
    );
    const granted = await app.request('/v1/subscriptions/5/grant', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 9 }),
    });
    expect(await granted.json()).toMatchObject({ quotaAdded: '10', replayed: false });
    expect(grantPack).toHaveBeenCalledWith(expect.objectContaining({ packId: 5, userId: 9 }));
  });

  it('cancel 回执;幂等冲突 409 billing.idempotency_conflict', async () => {
    const app = createAdminApp(
      fakeDeps({
        subscriptions: {
          cancel: async () => {
            throw BillingErrors.business('idempotency_conflict', { refId: 'x' });
          },
        },
      }),
    );
    const res = await app.request('/v1/subscriptions/5/cancel', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'billing.idempotency_conflict' } });
  });
});
