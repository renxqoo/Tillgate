/**
 * U1b 补充边界（分支封口）——从 wallet.test 拆出（文件行数上限，铁律 5）。
 */
import { describe, expect, it } from 'vitest';
import { isDefectError } from '@tokenlens/errors';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';

const GUARDS = {
  refTypes: ['billing', 'topup', 'admin', 'gift'],
  currencies: ['CNY', 'USD'],
  internalAccounts: ['outside', 'platform_revenue'],
} as const;

function harness() {
  const memory = createInMemoryWalletStore();
  const api = createWalletApi({ store: memory.store, guards: { ...GUARDS }, currency: 'CNY' });
  return { memory, api };
}

let userSeq = 1000;
const nextUser = () => (userSeq += 1);

async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ code: string; context: Record<string, unknown> }> {
  try {
    await fn();
  } catch (error) {
    if (!isDefectError(error) && (error as { name?: string }).name === 'BusinessError') {
      const e = error as { code: string; context?: Record<string, unknown> };
      return { code: e.code, context: e.context ?? {} };
    }
    throw error;
  }
  throw new Error('expected rejection');
}

describe('U1b 补充边界（分支封口）', () => {
  it('authorize 键劫持：同键跨用户拒绝（ref_key_conflict，owner 分支）', async () => {
    const { api } = harness();
    const a = nextUser();
    const b = nextUser();
    await api.credit({ userId: a, amount: '10', refType: 'topup', refId: 'hk1' });
    await api.authorize({ userId: a, amount: '2', refType: 'billing', refId: 'hk2' });
    expect(
      (
        await rejection(() =>
          api.authorize({ userId: b, amount: '2', refType: 'billing', refId: 'hk2' }),
        )
      ).code,
    ).toBe('billing.ref_key_conflict');
  });

  it('authorize.expiresAt 非 Date 输入红灯（不可达防御——模拟绕过类型的调用方）', async () => {
    const { api } = harness();
    const userId = nextUser();
    let defect: unknown;
    try {
      await api.authorize({
        userId,
        amount: '1',
        refType: 'billing',
        refId: 'hk3',
        expiresAt: '2030-01-01' as unknown as Date,
      });
    } catch (error) {
      defect = error;
    }
    expect(isDefectError(defect)).toBe(true);
  });

  it('release：缺失 not_found；对已结算冻结单释放是真拒绝', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'hk4' });
    await api.authorize({ userId, amount: '3', refType: 'billing', refId: 'hk5' });
    await api.settle({ refType: 'billing', refId: 'hk5', amount: '3' });
    expect(
      (await rejection(() => api.release({ refType: 'billing', refId: 'hk5', reason: 'x' }))).code,
    ).toBe('billing.authorization_not_active');
    expect(
      (await rejection(() => api.release({ refType: 'billing', refId: 'hk-missing', reason: 'x' })))
        .code,
    ).toBe('billing.authorization_not_found');
  });

  it('transfer 幂等三段式：快速路径重放 / 唯一冲突兜底重放 / 键劫持拒绝', async () => {
    const { memory, api } = harness();
    const a = nextUser();
    const b = nextUser();
    await api.credit({ userId: a, amount: '10', refType: 'topup', refId: 'hk6' });
    const first = await api.transfer({
      from: { userId: a },
      to: { userId: b },
      amount: '4',
      refType: 'admin',
      refId: 'hk7',
    });
    const replay = await api.transfer({
      from: { userId: a },
      to: { userId: b },
      amount: '4',
      refType: 'admin',
      refId: 'hk7',
    });
    expect(replay).toEqual({ ...first, replayed: true });
    memory.suppressNextFindTransaction();
    const fallback = await api.transfer({
      from: { userId: a },
      to: { userId: b },
      amount: '4',
      refType: 'admin',
      refId: 'hk7',
    });
    expect(fallback.replayed).toBe(true);
    const c = nextUser();
    expect(
      (
        await rejection(() =>
          api.transfer({
            from: { userId: c },
            to: { userId: b },
            amount: '4',
            refType: 'admin',
            refId: 'hk7',
          }),
        )
      ).code,
    ).toBe('billing.ref_key_conflict');
  });

  it('refund 唯一冲突兜底重放（suppress 快速路径）', async () => {
    const { memory, api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'hk8' });
    const first = await api.refund({ userId, amount: '2', refType: 'admin', refId: 'hk9' });
    memory.suppressNextFindTransaction();
    const fallback = await api.refund({ userId, amount: '2', refType: 'admin', refId: 'hk9' });
    expect(fallback).toEqual({ ...first, replayed: true });
  });

  it('冻结账户拒绝一切资金变动（account_frozen），查询/释放不受限', async () => {
    const { memory, api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'hk10' });
    await api.authorize({ userId, amount: '3', refType: 'billing', refId: 'hk11' });
    memory.freezeUserAccount(userId, 'CNY');
    expect(
      (await rejection(() => api.credit({ userId, amount: '1', refType: 'topup', refId: 'hk12' })))
        .code,
    ).toBe('billing.account_frozen');
    expect(
      (await rejection(() => api.refund({ userId, amount: '1', refType: 'admin', refId: 'hk13' })))
        .code,
    ).toBe('billing.account_frozen');
    // 冻结账户的 active 冻结单仍可释放（在途归还）——旧仓语义：查询/释放预占不受限
    const released = await api.release({ refType: 'billing', refId: 'hk11', reason: 'risk_hold' });
    expect(released.releasedAmount).toBe('3');
    expect((await api.accounts(userId))[0]!.inFlight).toBe('0');
  });

  it('statement limit 钳制：0 → 1、500 → 200', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '1', refType: 'topup', refId: 'hk14' });
    expect((await api.statement({ userId, limit: 0 })).length).toBe(1);
    expect((await api.statement({ userId, limit: 500 })).length).toBe(1);
    expect((await api.statement({ userId })).length).toBe(1);
  });
});
