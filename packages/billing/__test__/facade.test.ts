/**
 * createBilling facade 装配冒烟（内存 stand-in）：组合面完整、四子面可用、
 * 未注入可选 store 时的显式红灯（禁静默降级）。
 */
import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/billing.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import { defined } from './defined.js';

const CONFIG = {
  guards: {
    refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack', 'redeem'],
    currencies: ['CNY'],
    internalAccounts: ['outside', 'platform_revenue'],
  },
  currency: 'CNY',
  resolver: {
    resolve: () =>
      Promise.resolve({
        subscriptionId: null,
        allowPaygFallback: true,
        userDailyLimit: null,
        keyDailyLimit: null,
      }),
  },
  usageDefectBreaker: 5,
  failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
  clock: () => new Date(),
  onError: () => {},
} as const;

function assemble() {
  const walletMemory = createInMemoryWalletStore();
  const world = createInMemoryBillingWorld();
  return createBilling(
    {
      walletStore: walletMemory.store,
      store: world.billing,
      quota: world.quota,
      channels: world.channels,
      accounts: world.accountContext,
    },
    { ...CONFIG },
  );
}

describe('createBilling facade', () => {
  it('四子面装配完整：wallet/billing/settlement/subscriptions 可用', () => {
    const billing = assemble();
    expect(typeof billing.wallet.credit).toBe('function');
    expect(typeof billing.billing.authorize).toBe('function');
    expect(typeof billing.settlement.claim).toBe('function');
    expect(typeof billing.subscriptions.purchase).toBe('function');
  });

  it('全链贯通：充值 → 授权 → 失败释放（facade 组合下面协作无缺口）', async () => {
    const billing = assemble();
    const userId = 4242;
    await billing.wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'c1' });
    const quote = {
      maxOutputTokens: 0,
      candidates: [
        {
          mappingId: 1,
          externalModel: 'm',
          realModel: 'm',
          inputPrice: '2',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          inputTokenUpperBound: 1_000_000,
          billingPolicyFingerprint: null,
        },
      ],
    };
    const auth = await billing.billing.authorize({
      requestId: '00000000-0000-4000-8000-00000000face',
      userId,
      stream: false,
      quote,
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    expect(auth.reservedAmount).toBe('2');
    const failed = await billing.billing.signal({
      type: 'request.failed',
      requestId: '00000000-0000-4000-8000-00000000face',
      reason: 'x',
    });
    expect(failed.amountReleased).toBe('2');
    expect(defined((await billing.wallet.accounts(userId))[0]).inFlight).toBe('0');
  });

  it('未注入可选 store 的显式红灯（accounts 缺席 → subscriptions 拒绝；禁静默降级）', async () => {
    const walletMemory = createInMemoryWalletStore();
    const world = createInMemoryBillingWorld();
    const billing = createBilling(
      { walletStore: walletMemory.store, store: world.billing, quota: world.quota },
      { ...CONFIG },
    );
    await expect(
      billing.subscriptions.purchase({ operationId: 'op-x', userId: 1, planId: 1 }),
    ).rejects.toThrow(/not assembled/);
  });
});
