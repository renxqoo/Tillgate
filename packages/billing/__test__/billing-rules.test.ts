/**
 * 计费域规则行为规格（死信家族按三性/码判定）。
 */
import { describe, expect, it } from 'vitest';
import { DefectError, isBusinessError } from '@tillgate/errors';
import { BillingErrors } from '../src/domain/errors.js';
import { Decimal } from '../src/domain/money.js';
import { allocateSettlement } from '../src/domain/billing/settle-allocation.js';
import { isDeadLetterFamily, settleFailurePolicy } from '../src/domain/billing/settle-failure.js';
import { isTerminal } from '../src/domain/billing/reservation.js';
import { assertDailySpendLimit } from '../src/domain/billing/daily-limit.js';
import {
  billingDayKey,
  billingDayStart,
  billingMonthStart,
  secondsUntilNextBillingDay,
} from '../src/domain/billing/daily-window.js';
import { subscriptionAvailability } from '../src/domain/billing/subscription-availability.js';
import { defined } from './defined.js';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error(`expected business rejection (${code})`);
  expect((caught as { code: string }).code).toBe(code);
}

describe('allocateSettlement（多来源分摊）', () => {
  it('单源 under：consume = actual，余量隐式归还', () => {
    const [share] = allocateSettlement([{ sourceType: 'payg', amount: '2' }], new Decimal('0.6'));
    expect(defined(share).consume).toBe('0.6');
    expect(defined(share).over).toBe('0');
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

  it('切分链 over：超额由 PAYG 兜底吸收，订阅不超核', () => {
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

  it('纯订阅链 over：套餐不超核，超额单独交余额补扣', () => {
    const [share] = allocateSettlement(
      [{ sourceType: 'subscription', amount: '2' }],
      new Decimal('3'),
    );
    expect(defined(share).consume).toBe('2');
    expect(defined(share).over).toBe('1');
  });

  it('零源 + 正金额 = 不变量红灯（DefectError）；零源零额 = 空分配', () => {
    let defect: unknown;
    try {
      allocateSettlement([], new Decimal('1'));
    } catch (error) {
      defect = error;
    }
    expect(defect).toBeInstanceOf(DefectError);
    expect(allocateSettlement([], new Decimal(0))).toEqual([]);
  });
});

describe('settleFailurePolicy（死信 vs 退避）', () => {
  const config = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

  it('死信家族：毒收据/用户错配/配置事故/一切 DefectError → 立即 dead', () => {
    expect(
      settleFailurePolicy(BillingErrors.business('poison_receipt'), { ...config, attempt: 1 }).dead,
    ).toBe(true);
    expect(
      settleFailurePolicy(BillingErrors.business('receipt_user_mismatch'), {
        ...config,
        attempt: 1,
      }).dead,
    ).toBe(true);
    expect(
      settleFailurePolicy(BillingErrors.business('invalid_quote'), { ...config, attempt: 1 }).dead,
    ).toBe(true);
    expect(
      settleFailurePolicy(new DefectError('wallet invariant', 'billing.wallet_invariant'), {
        ...config,
        attempt: 1,
      }).dead,
    ).toBe(true);
  });

  it('业务拒绝（余额不足类）与未知错误 → 瞬态退避，次数耗尽 dead', () => {
    const business = BillingErrors.business('insufficient_balance');
    expect(isDeadLetterFamily(business)).toBe(false);
    const first = settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt: 1 });
    expect(first).toMatchObject({ dead: false, retryInMs: 100 });
    const second = settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt: 2 });
    expect(second).toMatchObject({ dead: false, retryInMs: 200 });
    expect(settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt: 3 }).dead).toBe(true);
  });

  it('退避封顶 maxDelayMs', () => {
    const decision = settleFailurePolicy(new Error('timeout'), {
      ...config,
      attempt: 10,
      maxAttempts: 20,
    });
    expect(decision).toMatchObject({ dead: false, retryInMs: 1_000 });
  });

  // F-1 回归(live-fire 红队 F-1):attempt 非有限数值曾产出 NaN 退避 →
  // casToRetryOrDead 的 interval 乘法 SQL 报错 → 逃逸成 worker 进程级故障。
  // 防护语义:非法计数一律死信(_invalid_attempt),NaN/Infinity 永不流向 SQL。
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['0', 0],
    ['-1', -1],
  ])('attempt 非法(%s)→ 立即死信 _invalid_attempt,不产 NaN 退避', (_name, attempt) => {
    const decision = settleFailurePolicy(new Error('ECONNRESET'), { ...config, attempt });
    expect(decision).toMatchObject({ dead: true, failureClass: 'Error_invalid_attempt' });
  });

  it('退避参数双非有限(配置腐坏:Math.min 两臂皆 Infinity)→ 死信 _invalid_delay', () => {
    const decision = settleFailurePolicy(new Error('timeout'), {
      maxAttempts: 100,
      baseDelayMs: Number.POSITIVE_INFINITY,
      maxDelayMs: Number.POSITIVE_INFINITY,
      attempt: 2,
    });
    expect(decision).toMatchObject({ dead: true, failureClass: 'Error_invalid_delay' });
  });
});

describe('BillingStatus 状态机', () => {
  it('终态仅 settled/released；dead 是人工复核出口', () => {
    expect(isTerminal('settled')).toBe(true);
    expect(isTerminal('released')).toBe(true);
    expect(isTerminal('dead')).toBe(false);
    expect(isTerminal('authorized')).toBe(false);
    expect(isTerminal('retry_wait')).toBe(false);
  });
});

describe('每日限额与计费日窗口', () => {
  it('projected = 已结算 + 在途 + 本次 > 限额 → 拒绝（user/key 双 scope 同口径）', () => {
    expect(() =>
      assertDailySpendLimit({
        scope: 'user',
        userId: 1,
        limit: '10',
        spent: '8',
        exposure: '0',
        amount: '2',
      }),
    ).not.toThrow();
    expectCode(
      () =>
        assertDailySpendLimit({
          scope: 'user',
          userId: 1,
          limit: '10',
          spent: '8',
          exposure: '0',
          amount: '2.01',
        }),
      'billing.daily_spend_limit',
    );
    expectCode(
      () =>
        assertDailySpendLimit({
          scope: 'key',
          userId: 1,
          apiKeyId: 9,
          limit: '10',
          spent: '8',
          exposure: '0',
          amount: '3',
        }),
      'billing.daily_spend_limit',
    );
  });

  it('计费日窗口：本地自然日键 / 0 点 / 距次日秒数至少 1', () => {
    const now = new Date(2026, 7, 23, 15, 30, 0);
    expect(billingDayKey(now)).toBe('2026-08-23');
    expect(billingDayStart(now).getTime()).toBe(new Date(2026, 7, 23).getTime());
    expect(secondsUntilNextBillingDay(new Date(2026, 7, 23, 23, 59, 59))).toBe(1);
    expect(secondsUntilNextBillingDay(new Date(2026, 7, 23, 0, 0, 0))).toBe(86_400);
  });

  it('月度窗口单一真相：billingMonthStart = 本地自然月 1 日 0 点（跨年/月中）', () => {
    expect(billingMonthStart(new Date(2026, 7, 23, 15, 30)).getTime()).toBe(
      new Date(2026, 7, 1).getTime(),
    );
    expect(billingMonthStart(new Date(2026, 11, 31, 23, 59)).getTime()).toBe(
      new Date(2026, 11, 1).getTime(),
    );
    // 跨年：2027-01-01 0 点
    expect(billingMonthStart(new Date(2027, 0, 1, 0, 0)).getTime()).toBe(
      new Date(2027, 0, 1).getTime(),
    );
  });
});

describe('subscriptionAvailability（订阅来源闸）', () => {
  const sub = { ownerId: 7, orgId: null, quotaAmount: '10', usedAmount: '3', reservedAmount: '1' };
  const input = { userId: 7, subscriptionId: 1, amount: '5', allowPaygFallback: false };

  it('owner：可用 = quota − used − reserved，覆盖即过', () => {
    expect(
      subscriptionAvailability(
        {
          subscription: sub,
          membership: null,
          dailySpent: null,
          monthlySpent: null,
          exposure: null,
        },
        input,
      ).toString(),
    ).toBe('6');
  });

  it('无有效订阅 → subscription_required（与开关无关）', () => {
    expectCode(
      () =>
        subscriptionAvailability(
          {
            subscription: null,
            membership: null,
            dailySpent: null,
            monthlySpent: null,
            exposure: null,
          },
          input,
        ),
      'billing.subscription_required',
    );
  });

  it('非 owner 且无成员资格 → subscription_forbidden', () => {
    expectCode(
      () =>
        subscriptionAvailability(
          {
            subscription: sub,
            membership: null,
            dailySpent: null,
            monthlySpent: null,
            exposure: null,
          },
          { ...input, userId: 8 },
        ),
      'billing.subscription_forbidden',
    );
  });

  it('成员路径：可用 = min(套餐余量, 日限余量, 月配额余量)；防御性 clamp ≥ 0', () => {
    const snapshot = {
      subscription: sub,
      membership: { dailySpendLimit: '4', monthlyQuota: '20' },
      dailySpent: '1',
      monthlySpent: '5',
      exposure: '0',
    };
    // 套餐 6、日限 4-1=3、月配额 20-5=15 → 3（amount 2 ≤ 3 放行）
    expect(
      subscriptionAvailability(snapshot, { ...input, userId: 8, amount: '2' }).toString(),
    ).toBe('3');
    // 异常数据（used+reserved > quota）不产生负可用
    const broken = {
      ...snapshot,
      subscription: { ...sub, usedAmount: '9', reservedAmount: '9' },
    };
    // 覆盖不足时 fallback=ON 返回钳制后的 0（缺口交 PAYG）；OFF 则拒绝
    expect(
      subscriptionAvailability(broken, {
        ...input,
        userId: 8,
        amount: '0.5',
        allowPaygFallback: true,
      }).toString(),
    ).toBe('0');
    expectCode(
      () => subscriptionAvailability(broken, { ...input, userId: 8, amount: '0.5' }),
      'billing.subscription_quota_exhausted',
    );
  });

  it('开关 OFF 覆盖不足：判定次序 daily → monthly → quota', () => {
    const base = {
      subscription: sub,
      membership: { dailySpendLimit: '2', monthlyQuota: '30' },
      dailySpent: '1',
      monthlySpent: '0',
      exposure: '0',
    };
    expectCode(
      () => subscriptionAvailability(base, { ...input, userId: 8, amount: '2' }),
      'billing.member_daily_limit',
    );
    const monthly = { ...base, membership: { dailySpendLimit: null, monthlyQuota: '3' } };
    expectCode(
      () => subscriptionAvailability(monthly, { ...input, userId: 8, amount: '4' }),
      'billing.member_monthly_quota',
    );
    const quotaOnly = {
      subscription: sub,
      membership: null,
      dailySpent: null,
      monthlySpent: null,
      exposure: null,
    };
    expectCode(
      () => subscriptionAvailability(quotaOnly, { ...input, amount: '7' }),
      'billing.subscription_quota_exhausted',
    );
  });

  it('开关 ON 覆盖不足：返回余量（缺口留给 PAYG 补差）', () => {
    const availability = subscriptionAvailability(
      { subscription: sub, membership: null, dailySpent: null, monthlySpent: null, exposure: null },
      { ...input, amount: '9', allowPaygFallback: true },
    );
    expect(availability.toString()).toBe('6');
  });
});
