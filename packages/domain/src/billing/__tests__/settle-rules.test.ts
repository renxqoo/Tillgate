/** 结算分配与失败策略（纯函数）：切分/超额吸收/死信家族/退避。 */
import { describe, expect, it } from 'vitest';
import { BillingInvariantError } from '../errors.js';
import { allocateSettlement } from '../settle-allocation.js';
import { settleFailurePolicy } from '../settle-failure.js';
import { PoisonReceiptError } from '../../rating/errors.js';
import { WalletInvariantError } from '../../wallet/errors.js';
import { Decimal } from '../../wallet/money.js';

describe('allocateSettlement', () => {
  it('单源 under：consume = actual，余量隐式归还', () => {
    const [share] = allocateSettlement([{ sourceType: 'payg', amount: '2' }], new Decimal('0.6'));
    expect(share!.consume).toBe('0.6');
    expect(share!.over).toBe('0');
  });

  it('切分链 under：优先级序消耗（订阅先），各源不超预留', () => {
    const shares = allocateSettlement(
      [
        { sourceType: 'subscription', amount: '1' },
        { sourceType: 'payg', amount: '1' },
      ],
      new Decimal('1.5'),
    );
    expect(shares.map((s) => [s.sourceType, s.consume, s.over])).toEqual([
      ['subscription', '1', '0'],
      ['payg', '0.5', '0'],
    ]);
  });

  it('切分链 over：超额由 PAYG 兜底吸收（§4），订阅不超核', () => {
    const shares = allocateSettlement(
      [
        { sourceType: 'subscription', amount: '1' },
        { sourceType: 'payg', amount: '1' },
      ],
      new Decimal('2.5'),
    );
    expect(shares.map((s) => [s.sourceType, s.consume, s.over])).toEqual([
      ['subscription', '1', '0'],
      ['payg', '1', '0.5'],
    ]);
  });

  it('纯订阅链 over：额度池直接吸收（consume 超预留）', () => {
    const [share] = allocateSettlement(
      [{ sourceType: 'subscription', amount: '2' }],
      new Decimal('3'),
    );
    expect(share!.consume).toBe('3');
    expect(share!.over).toBe('0');
  });

  it('零源 + 正金额 = 不变量（不应可达的防御）', () => {
    expect(() => allocateSettlement([], new Decimal('1'))).toThrow(BillingInvariantError);
    expect(allocateSettlement([], new Decimal(0))).toEqual([]);
  });
});

describe('settleFailurePolicy', () => {
  const config = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

  it('死信家族：毒收据/不变量 → 立即 dead', () => {
    expect(settleFailurePolicy(new PoisonReceiptError(), { ...config, attempt: 1 }).dead).toBe(true);
    expect(settleFailurePolicy(new WalletInvariantError('x'), { ...config, attempt: 1 }).dead).toBe(true);
  });

  it('瞬态错误：指数退避，次数耗尽 dead', () => {
    const first = settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt: 1 });
    expect(first).toMatchObject({ dead: false, retryInMs: 100 });
    const second = settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt: 2 });
    expect(second).toMatchObject({ dead: false, retryInMs: 200 });
    const last = settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt: 3 });
    expect(last.dead).toBe(true);
  });

  it('退避封顶 maxDelayMs', () => {
    const decision = settleFailurePolicy(new Error('timeout'), {
      ...config,
      attempt: 10,
      maxAttempts: 20,
    });
    expect(decision).toMatchObject({ dead: false, retryInMs: 1_000 });
  });
});
