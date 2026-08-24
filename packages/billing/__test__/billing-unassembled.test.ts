/**
 * 装配缺失红灯与订阅共享件分支（覆盖率门禁补测，铁律 16 只补测试）：
 * 未注入 channel/accountContext port 时公共 API 必须抛 DefectError 而非静默降级；
 * 唯一索引并发兜底的 cause 链遍历与幂等包装的错误映射逐分支覆盖。
 */
import { describe, expect, it } from 'vitest';
import { createBilling } from '../src/billing.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { createInMemoryBillingWorld } from '../src/testing/in-memory-billing-store.js';
import {
  isOneActiveViolation,
  runSubscribeOperation,
} from '../src/application/subscriptions/subscription-shared.js';
import { BillingErrors } from '../src/domain/errors.js';

const uq = (constraint: string) => ({ code: '23505', constraint });

/** 幂等包装测试替身:operations.run 直接抛给定错误 */
const assembly = (err: unknown) =>
  ({
    operations: {
      run: async () => {
        throw err;
      },
    },
  }) as unknown as Parameters<typeof runSubscribeOperation>[0];

function bareApi() {
  const walletMemory = createInMemoryWalletStore();
  const world = createInMemoryBillingWorld();
  // 故意不注入 channels / accounts——触发装配缺失红灯
  return createBilling(
    {
      store: world.billing,
      quota: world.quota,
      walletStore: walletMemory.store,
    },
    {
      currency: 'CNY',
      clock: () => new Date(),
      guards: {
        refTypes: ['billing', 'topup', 'admin'],
        currencies: ['CNY'],
        internalAccounts: ['outside', 'platform_revenue'],
      },
    } as never,
  );
}

describe('装配缺失红灯(DefectError,禁静默降级)', () => {
  it('未注入 accountContext 时订阅动词首步即抛 billing.account_context_unassembled', async () => {
    const api = bareApi();
    await expect(
      api.subscriptions.purchase({ userId: 1, planId: 1, quantity: 1 } as never),
    ).rejects.toMatchObject({ code: 'billing.account_context_unassembled' });
  });
});

describe('isOneActiveViolation(cause 链逐分支)', () => {
  it('直接命中 active_uq', () => {
    expect(isOneActiveViolation(uq('user_subscriptions_one_active_uq'))).toBe(true);
  });
  it('直接命中 org_uq', () => {
    expect(isOneActiveViolation(uq('user_subscriptions_one_org_uq'))).toBe(true);
  });
  it('cause 链第二层命中', () => {
    expect(isOneActiveViolation({ cause: uq('user_subscriptions_one_org_uq') })).toBe(true);
  });
  it('code 相同但约束名无关 → false', () => {
    expect(isOneActiveViolation(uq('other_uq'))).toBe(false);
  });
  it('cause 链超深(第六层才命中) → false', () => {
    // 1..6 层无标识,第 7 层才是 uq——超过遍历深度 5,应返回 false
    let deep: { code?: string; constraint?: string; cause?: unknown } = uq(
      'user_subscriptions_one_org_uq',
    );
    for (let i = 0; i < 6; i += 1) deep = { cause: deep };
    expect(isOneActiveViolation(deep)).toBe(false);
  });
});

describe('runSubscribeOperation(幂等包装错误映射)', () => {
  it('唯一索引冲突 → already_subscribed 业务错误', async () => {
    await expect(
      runSubscribeOperation(assembly(uq('user_subscriptions_one_active_uq')), {
        operationId: 'x',
        fingerprint: 'f',
        userId: 1,
        payload: {},
        execute: async () => ({}),
      } as never),
    ).rejects.toMatchObject(
      BillingErrors.business('subscription_state', { reason: 'already_subscribed' }),
    );
  });
  it('其他错误原样上抛', async () => {
    const boom = new Error('unrelated');
    await expect(
      runSubscribeOperation(assembly(boom), {
        operationId: 'x',
        fingerprint: 'f',
        userId: 1,
        payload: {},
        execute: async () => ({}),
      } as never),
    ).rejects.toBe(boom);
  });
});
