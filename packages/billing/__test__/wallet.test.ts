/**
 * 钱包动词契约测试（内存 stand-in；迁移自旧仓 service/__tests__/wallet*.test.ts 行为规格，
 * 真实 PostgreSQL 并发/触发器语义在 wallet-*.real.test.ts）。
 * 覆盖：动词闭环、幂等三段式（快速路径 + 唯一冲突兜底重放）、同键异命令 409、
 * 键劫持归属、出账守卫口径、B1/B5 回归、读侧规范化。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError, isDefectError } from '@tokenlens/errors';
import { BillingErrors } from '../src/domain/errors.js';
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

async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ code: string; context: Record<string, unknown> }> {
  try {
    await fn();
  } catch (error) {
    if (!isBusinessError(error)) {
      throw new Error(`expected business rejection, got: ${String(error)}`, { cause: error });
    }
    return { code: error.code, context: (error.context ?? {}) as Record<string, unknown> };
  }
  throw new Error('expected rejection');
}

let userSeq = 0;
const nextUser = () => (userSeq += 1);

describe('credit / refund（腿级幂等）', () => {
  it('入账双腿落账、余额精确、首答与重放回执全等（含金额字符串形态——B5 同型锁定）', async () => {
    const { api } = harness();
    const userId = nextUser();
    const first = await api.credit({ userId, amount: '10.500', refType: 'topup', refId: 'o1' });
    expect(first).toEqual({
      transactionId: 1,
      amount: '10.5',
      balanceAfter: '10.5',
      replayed: false,
    });
    const replay = await api.credit({ userId, amount: '10.500', refType: 'topup', refId: 'o1' });
    expect(replay).toEqual({ ...first, replayed: true });
    // 尾零输入的重放同样得到规范化首答
    const again = await api.credit({ userId, amount: '10.5', refType: 'topup', refId: 'o1' });
    expect(again.amount).toBe('10.5');
    const accounts = await api.accounts(userId);
    expect(accounts[0]!.balance).toBe('10.5');
  });

  it('唯一冲突兜底重放（suppress 快速路径模拟读后写竞态）——回执仍是首笔', async () => {
    const { memory, api } = harness();
    const userId = nextUser();
    const first = await api.credit({ userId, amount: '5', refType: 'topup', refId: 'o2' });
    memory.suppressNextFindTransaction();
    const replay = await api.credit({ userId, amount: '5', refType: 'topup', refId: 'o2' });
    expect(replay).toEqual({ ...first, replayed: true });
  });

  it('同键异命令拒绝（idempotency_conflict）；跨用户键劫持拒绝（ref_key_conflict）', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '5', refType: 'topup', refId: 'o3' });
    expect(
      (await rejection(() => api.credit({ userId, amount: '6', refType: 'topup', refId: 'o3' })))
        .code,
    ).toBe('billing.idempotency_conflict');
    const other = nextUser();
    expect(
      (
        await rejection(() =>
          api.credit({ userId: other, amount: '5', refType: 'topup', refId: 'o3' }),
        )
      ).code,
    ).toBe('billing.ref_key_conflict');
  });

  it('refund 出账守卫（信用口径：授信参与可用额）与独立幂等域', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'r1' });
    const refund = await api.refund({ userId, amount: '4', refType: 'admin', refId: 'rf1' });
    expect(refund.balanceAfter).toBe('6');
    const replay = await api.refund({ userId, amount: '4', refType: 'admin', refId: 'rf1' });
    expect(replay.replayed).toBe(true);
    // 同 refType/refId 不同 kind 不顶撞（credit 与 refund 幂等域隔离）
    await api.credit({ userId, amount: '1', refType: 'admin', refId: 'rf1' });
    expect((await api.accounts(userId))[0]!.balance).toBe('7');
    const insufficient = await rejection(() =>
      api.refund({ userId, amount: '8', refType: 'admin', refId: 'rf2' }),
    );
    expect(insufficient.code).toBe('billing.insufficient_balance');
    expect(insufficient.context).toEqual({
      userId,
      available: '7',
      required: '8',
      currency: 'CNY',
    });
  });
});

describe('authorize / settle / release（两阶段闭环）', () => {
  it('冻结占在途不动余额；结算双腿落账 + 余量归还', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'c1' });
    const auth = await api.authorize({ userId, amount: '7', refType: 'billing', refId: 'b1' });
    expect(auth.status).toBe('active');
    expect((await api.accounts(userId))[0]!.inFlight).toBe('7');
    expect((await api.accounts(userId))[0]!.balance).toBe('10');
    const settled = await api.settle({ refType: 'billing', refId: 'b1', amount: '6' });
    expect(settled).toMatchObject({
      settledAmount: '6',
      balanceAfter: '4',
      releasedRemainder: '1',
      replayed: false,
    });
    expect((await api.accounts(userId))[0]!.inFlight).toBe('0');
    // 结算重放 = 首答（settled 分支读回腿上稳定回执）
    const replay = await api.settle({ refType: 'billing', refId: 'b1', amount: '6' });
    expect(replay).toEqual({ ...settled, replayed: true });
  });

  it('B5 锁定：authorize 首调与重放的 amount 字符串全等（规范化不漂移）', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'c2' });
    const first = await api.authorize({ userId, amount: '3.500', refType: 'billing', refId: 'b2' });
    expect(first.amount).toBe('3.5');
    const replay = await api.authorize({ userId, amount: '3.5', refType: 'billing', refId: 'b2' });
    expect(replay.amount).toBe('3.5');
    expect(replay.replayed).toBe(true);
  });

  it('可用口径守卫：在途挤占可用额（第二笔冻结拒且无残留）', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'c3' });
    await api.authorize({ userId, amount: '8', refType: 'billing', refId: 'b3' });
    const rejected = await rejection(() =>
      api.authorize({ userId, amount: '3', refType: 'billing', refId: 'b4' }),
    );
    expect(rejected.code).toBe('billing.insufficient_balance');
    expect((await api.accounts(userId))[0]!.inFlight).toBe('8');
  });

  it('现金口径（allowCredit:false）：授信不参与可用额', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '5', refType: 'topup', refId: 'c4' });
    await api.setCreditLimit({ userId, amount: '10', refType: 'admin', refId: 'cl1' });
    const ok = await api.authorize({ userId, amount: '5', refType: 'billing', refId: 'b5' });
    expect(ok.status).toBe('active');
    const rejected = await rejection(() =>
      api.authorize({ userId, amount: '1', refType: 'billing', refId: 'b6', allowCredit: false }),
    );
    expect(rejected.code).toBe('billing.insufficient_cash');
  });

  it('release：在途归还、重复释放幂等 no-op、释放后不可结算', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'c5' });
    await api.authorize({ userId, amount: '5', refType: 'billing', refId: 'b7' });
    const released = await api.release({
      refType: 'billing',
      refId: 'b7',
      reason: 'upstream_failed',
    });
    expect(released).toMatchObject({ releasedAmount: '5', replayed: false });
    expect((await api.accounts(userId))[0]!.inFlight).toBe('0');
    const replay = await api.release({
      refType: 'billing',
      refId: 'b7',
      reason: 'upstream_failed',
    });
    expect(replay).toMatchObject({ releasedAmount: '5', replayed: true });
    expect(
      (await rejection(() => api.settle({ refType: 'billing', refId: 'b7', amount: '1' }))).code,
    ).toBe('billing.authorization_not_active');
  });

  it('结算越权：超额拒绝且状态不变；不存在的冻结单 not_found', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'c6' });
    await api.authorize({ userId, amount: '5', refType: 'billing', refId: 'b8' });
    expect(
      (await rejection(() => api.settle({ refType: 'billing', refId: 'b8', amount: '5.01' }))).code,
    ).toBe('billing.settle_exceeds_hold');
    expect((await api.accounts(userId))[0]!.inFlight).toBe('5');
    expect(
      (await rejection(() => api.settle({ refType: 'billing', refId: 'nope', amount: '1' }))).code,
    ).toBe('billing.authorization_not_found');
  });

  it('authorize 重放经唯一冲突兜底同样全等（suppress 快速路径）', async () => {
    const { memory, api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'c7' });
    const first = await api.authorize({ userId, amount: '4', refType: 'billing', refId: 'b9' });
    memory.suppressNextFindAuthorization();
    const replay = await api.authorize({ userId, amount: '4', refType: 'billing', refId: 'b9' });
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await api.accounts(userId))[0]!.inFlight).toBe('4');
  });

  it('collectOverage 域约束：非 billing/#over 键使用即红灯缺陷', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '1', refType: 'topup', refId: 'c8' });
    let defect: unknown;
    try {
      await api.authorize({
        userId,
        amount: '1',
        refType: 'topup',
        refId: 'x',
        collectOverage: true,
      });
    } catch (error) {
      defect = error;
    }
    expect(isDefectError(defect)).toBe(true);
  });
});

describe('transfer / setCreditLimit', () => {
  it('划转守恒（用户↔用户）；from 出账守卫', async () => {
    const { api } = harness();
    const a = nextUser();
    const b = nextUser();
    await api.credit({ userId: a, amount: '10', refType: 'topup', refId: 't1' });
    const tx = await api.transfer({
      from: { userId: a },
      to: { userId: b },
      amount: '4',
      refType: 'admin',
      refId: 't2',
    });
    expect(tx).toMatchObject({ fromBalanceAfter: '6', toBalanceAfter: '4', replayed: false });
    expect(
      (
        await rejection(() =>
          api.transfer({
            from: { userId: a },
            to: { userId: b },
            amount: '7',
            refType: 'admin',
            refId: 't3',
          }),
        )
      ).code,
    ).toBe('billing.insufficient_balance');
  });

  it('setCreditLimit：审计交易落账 + 覆盖校验 + 幂等回执取存储值', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '5', refType: 'topup', refId: 'u1' });
    const set = await api.setCreditLimit({ userId, amount: '10' });
    expect(set).toEqual({ creditLimitAfter: '10', replayed: false });
    const replay = await api.setCreditLimit({ userId, amount: '10' });
    expect(replay).toEqual({ creditLimitAfter: '10', replayed: true });
    // 授信扩可用：可冻结 15
    await api.authorize({ userId, amount: '15', refType: 'billing', refId: 'u2' });
    // 降授信不得击穿敞口（在途 15 > 新授信覆盖能力；显式换键避免默认键的同键异额 409 先行）
    const conflict = await rejection(() =>
      api.setCreditLimit({ userId, amount: '1', refType: 'admin', refId: 'cl-lower' }),
    );
    expect(conflict.code).toBe('billing.credit_limit_conflict');
  });

  it('B1 回归：并发同键异额——唯一冲突兜底必须吃 409 而非把输入当回执（suppress 模拟输家路径）', async () => {
    const { memory, api } = harness();
    const userId = nextUser();
    const winner = await api.setCreditLimit({
      userId,
      amount: '10',
      refType: 'admin',
      refId: 'cl-b1',
    });
    expect(winner.creditLimitAfter).toBe('10');
    // 模拟输家：快速路径未命中（竞态窗口内），写路径撞唯一键，兜底比对指纹
    memory.suppressNextFindTransaction();
    const loser = await rejection(() =>
      api.setCreditLimit({ userId, amount: '99', refType: 'admin', refId: 'cl-b1' }),
    );
    expect(loser.code).toBe('billing.idempotency_conflict');
    // 快速路径上的同键异额同样 409
    const sequential = await rejection(() =>
      api.setCreditLimit({ userId, amount: '99', refType: 'admin', refId: 'cl-b1' }),
    );
    expect(sequential.code).toBe('billing.idempotency_conflict');
  });
});

describe('读侧与装配校验', () => {
  it('accounts 金额出口规范化（DB numeric 尾零不外泄）；statement 腿级倒序 + kinds 过滤', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '2.500', refType: 'topup', refId: 's1' });
    await api.credit({ userId, amount: '1', refType: 'gift', refId: 's2' });
    const accounts = await api.accounts(userId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      balance: '3.5',
      inFlight: '0',
      creditLimit: '0',
      currency: 'CNY',
    });
    const page = await api.statement({ userId, limit: 10 });
    expect(page.map((item) => item.refType)).toEqual(['gift', 'topup']);
    expect(page[0]!.amount).toBe('1');
    // kinds 按**交易种类**过滤（两笔都是 credit；再退一笔后按 refund 过滤命中它）
    await api.refund({ userId, amount: '0.5', refType: 'admin', refId: 'rf-s' });
    const creditsOnly = await api.statement({ userId, kinds: ['credit'], limit: 10 });
    expect(creditsOnly.map((item) => item.refId)).toEqual(['s2', 's1']);
    const refundsOnly = await api.statement({ userId, kinds: ['refund'], limit: 10 });
    expect(refundsOnly.map((item) => item.refId)).toEqual(['rf-s']);
    // 游标翻页：取前两腿后从其最小 legId 续读，剩余恰好一条
    const firstPage = await api.statement({ userId, limit: 2 });
    expect(firstPage.map((item) => item.refId)).toEqual(['rf-s', 's2']);
    const next = await api.statement({
      userId,
      limit: 10,
      beforeLegId: firstPage[1]!.legId,
    });
    expect(next.map((item) => item.refId)).toEqual(['s1']);
  });

  it('多币种并存互不净额；装配币种必须过白名单', async () => {
    const { api } = harness();
    const userId = nextUser();
    await api.credit({ userId, amount: '10', refType: 'topup', refId: 'm1', currency: 'CNY' });
    await api.credit({ userId, amount: '20', refType: 'topup', refId: 'm2', currency: 'USD' });
    const accounts = await api.accounts(userId);
    expect(accounts.toSorted((x, y) => x.currency.localeCompare(y.currency))).toMatchObject([
      { currency: 'CNY', balance: '10' },
      { currency: 'USD', balance: '20' },
    ]);
    let threw = false;
    try {
      createWalletApi({
        store: createInMemoryWalletStore().store,
        guards: { ...GUARDS },
        currency: 'EUR',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('目录与动词错误契约对齐', () => {
  it('动词拒绝的 code 全部来自 billing 目录（无自造错误类）', async () => {
    const { api } = harness();
    const userId = nextUser();
    const cases: Array<[Promise<unknown> | (() => Promise<unknown>), string]> = [
      [
        api.credit({ userId, amount: '0', refType: 'topup', refId: 'z1' }),
        'billing.invalid_amount',
      ],
      [
        () => api.credit({ userId, amount: '1', refType: 'unknown', refId: 'z2' }),
        'billing.invalid_ref',
      ],
      [
        () =>
          api.credit({ userId, amount: '1', refType: 'topup', refId: 'z3', counterparty: 'nope' }),
        'billing.invalid_ref',
      ],
      [
        () => api.settle({ refType: 'topup', refId: 'z4', amount: '1' }),
        'billing.authorization_not_found',
      ],
    ];
    for (const [invoke, code] of cases) {
      const promise = typeof invoke === 'function' ? invoke() : invoke;
      const result = await rejection(() => promise);
      expect(result.code).toBe(code);
      expect(BillingErrors.has(result.code)).toBe(true);
    }
  });
});

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
