/**
 * 透支地板管理面单测：
 * 键值解析矩阵 / 新钱包套默认 / 手工覆盖 source / 批量刷默认（manual 不动、贴线跳过）/
 * 降低地板贴线冲突。内存 store + 注入 defaultFloor 解析器。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { parseDebitFloorDefault } from '../src/application/wallet/debit-floor.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import { defined } from './defined.js';

let userSeq = 900;
const nextUser = () => (userSeq += 1);

function harness(defaultFloor?: () => Promise<string | null>) {
  const memory = createInMemoryWalletStore(defaultFloor != null ? { defaultFloor } : {});
  const api = createWalletApi({
    store: memory.store,
    guards: {
      refTypes: ['billing', 'topup', 'admin'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  return { memory, api };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!isBusinessError(error)) throw error;
    expect(error.code).toBe(`billing.${code}`);
    return;
  }
  throw new Error(`expected rejection (${code})`);
}

describe('parseDebitFloorDefault（KV 值矩阵）', () => {
  it('合法/非法/缺省表驱动', () => {
    expect(parseDebitFloorDefault(null)).toBeNull();
    expect(parseDebitFloorDefault({})).toBeNull();
    expect(parseDebitFloorDefault({ floor: 5 })).toBeNull();
    expect(parseDebitFloorDefault({ floor: '' })).toBeNull();
    expect(parseDebitFloorDefault({ floor: 'abc' })).toBeNull();
    expect(parseDebitFloorDefault({ floor: '-1' })).toBeNull();
    expect(parseDebitFloorDefault({ floor: '0' })).toBe('0');
    expect(parseDebitFloorDefault({ floor: '0.5' })).toBe('0.5');
    expect(parseDebitFloorDefault({ floor: '12.345' })).toBe('12.345');
  });
});

describe('新钱包套默认', () => {
  it('defaultFloor 解析器返回值落列；未配置 = 0', async () => {
    const h = harness(() => Promise.resolve('0.5'));
    const userId = nextUser();
    await h.api.credit({ userId, amount: '1', refType: 'topup', refId: 'df-a1' });
    const account = defined((await h.api.accounts(userId))[0]);
    expect(account.debitFloor).toBe('0.5');
    expect(account.debitFloorSource).toBe('default');

    const h0 = harness();
    const u0 = nextUser();
    await h0.api.credit({ userId: u0, amount: '1', refType: 'topup', refId: 'df-a2' });
    expect(defined((await h0.api.accounts(u0))[0]).debitFloor).toBe('0');
  });

  it('解析器返回 null = 不套用（缺省 0）', async () => {
    const h = harness(() => Promise.resolve(null));
    const userId = nextUser();
    await h.api.credit({ userId, amount: '1', refType: 'topup', refId: 'df-a3' });
    expect(defined((await h.api.accounts(userId))[0]).debitFloor).toBe('0');
  });
});

describe('setDebitFloor（手工覆盖）', () => {
  it('写 manual 来源；同账号批量永不动', async () => {
    const h = harness();
    const userId = nextUser();
    await h.api.credit({ userId, amount: '1', refType: 'topup', refId: 'df-m1' });
    const r = await h.api.setDebitFloor({ userId, amount: '3' });
    expect(r.debitFloorAfter).toBe('3');
    const account = defined((await h.api.accounts(userId))[0]);
    expect(account.debitFloor).toBe('3');
    expect(account.debitFloorSource).toBe('manual');

    const applied = await h.api.applyDefaultFloor({ floor: '9' });
    expect(applied.applied).toBe(0); // manual 不在批量范围
    expect(defined((await h.api.accounts(userId))[0]).debitFloor).toBe('3');
  });

  it('降低地板击穿当前敞口 → debit_floor_conflict（经 #over 结算构造负可用）', async () => {
    const h = harness();
    const userId = nextUser();
    await h.api.credit({ userId, amount: '1', refType: 'topup', refId: 'df-c1' });
    await h.api.setDebitFloor({ userId, amount: '5' });
    // 在途 0.8 + #over 结算 5.2 → 余额 -4.2、可用 = -4.2 - 0.8 = -5.0（恰触地板）
    await h.api.authorize({ userId, amount: '0.8', refType: 'billing', refId: 'df-c-in' });
    await h.api.authorize({
      userId,
      amount: '5.2',
      refType: 'billing',
      refId: 'df-c-over#over',
      collectOverage: true,
    });
    await h.api.settle({ refType: 'billing', refId: 'df-c-over#over', amount: '5.2' });
    const mid = defined((await h.api.accounts(userId))[0]);
    expect(mid.balance).toBe('-4.2');
    expect(mid.inFlight).toBe('0.8');
    // 地板 0/4.29 击穿（可用 -5 + 新地板 < 0）；5 恰好贴线放行
    await expectCode(() => h.api.setDebitFloor({ userId, amount: '0' }), 'debit_floor_conflict');
    await expectCode(() => h.api.setDebitFloor({ userId, amount: '4.29' }), 'debit_floor_conflict');
    const ok = await h.api.setDebitFloor({ userId, amount: '5' });
    expect(ok.debitFloorAfter).toBe('5');
  });

  it('非法金额拒绝（负数/垃圾）', async () => {
    const h = harness();
    const userId = nextUser();
    await expectCode(() => h.api.setDebitFloor({ userId, amount: '-1' }), 'invalid_amount');
    await expectCode(() => h.api.setDebitFloor({ userId, amount: 'x' }), 'invalid_amount');
  });
});

describe('applyDefaultFloor（存量批量）', () => {
  it('default 行刷新值；manual 跳过；贴线不足跳过并计数', async () => {
    const h = harness();
    // u1/u2 = default 来源；u3 = manual；u4 = default 且余额已低于新地板线
    const u1 = nextUser();
    const u2 = nextUser();
    const u3 = nextUser();
    const u4 = nextUser();
    await h.api.credit({ userId: u1, amount: '1', refType: 'topup', refId: 'df-b1' });
    await h.api.credit({ userId: u2, amount: '2', refType: 'topup', refId: 'df-b2' });
    await h.api.credit({ userId: u3, amount: '1', refType: 'topup', refId: 'df-b3' });
    await h.api.setDebitFloor({ userId: u3, amount: '7' });
    // u4：经 defaultFloor=5 的 harness 建号（default 来源带地板），再 #over 结算
    // 构造 贴线恰好 0：余额 -4.2、在途 0.8、地板 5 → -4.2 + 5 - 0.8 = 0
    const h4 = harness(() => Promise.resolve('5'));
    await h4.api.credit({ userId: u4, amount: '1', refType: 'topup', refId: 'df-b4' });
    await h4.api.authorize({ userId: u4, amount: '0.8', refType: 'billing', refId: 'df-b5' });
    await h4.api.authorize({
      userId: u4,
      amount: '5.2',
      refType: 'billing',
      refId: 'df-b6#over',
      collectOverage: true,
    });
    await h4.api.settle({ refType: 'billing', refId: 'df-b6#over', amount: '5.2' });
    const u4mid = defined((await h4.api.accounts(u4))[0]);
    expect(u4mid.debitFloor).toBe('5');
    expect(u4mid.debitFloorSource).toBe('default');

    // 同库视角：u4 已在共享内存 store（h/h4 各自独立 store——改为同一 store 口径）
    // 注：harness 各建独立内存世界；批量断言在 h4 世界内补充 manual/default 混合
    await h4.api.credit({ userId: u1, amount: '1', refType: 'topup', refId: 'df-b7' });
    await h4.api.setDebitFloor({ userId: u1, amount: '2' }); // h4 世界里的 manual

    const r = await h4.api.applyDefaultFloor({ floor: '0' });
    expect(r.applied).toBe(0); // 唯一 default 行 u4 贴线 = -4.2 + 0 - 0.8 < 0 → 跳过
    expect(r.skipped).toBe(1);
    expect(defined((await h4.api.accounts(u4))[0]).debitFloor).toBe('5'); // 保持旧值
    expect(defined((await h4.api.accounts(u1))[0]).debitFloor).toBe('2'); // manual 未动

    // h 世界（u1/u2 default 正余额；u3 manual）：刷 1 全体 default 生效
    const r1 = await h.api.applyDefaultFloor({ floor: '1' });
    expect(r1.applied).toBe(2); // u1/u2（u3 manual、internal 不算）
    expect(r1.skipped).toBe(0);
    expect(defined((await h.api.accounts(u3))[0]).debitFloor).toBe('7'); // manual 未动
  });
});
