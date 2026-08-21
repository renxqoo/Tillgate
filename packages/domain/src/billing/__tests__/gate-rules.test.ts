/** 闸门规则（纯函数）：订阅可用额三语义 + 每日限额口径。 */
import { describe, expect, it } from 'vitest';
import {
  MemberDailyLimitExceededError,
  SubscriptionForbiddenError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
  DailySpendLimitExceededError,
} from '../errors.js';
import { subscriptionAvailability } from '../subscription-availability.js';
import { assertDailySpendLimit } from '../daily-limit.js';

const ownerSnapshot = {
  subscription: {
    ownerId: 7,
    orgId: null,
    quotaAmount: '5',
    usedAmount: '1',
    reservedAmount: '0',
  },
  membership: null,
  dailySpent: null,
  monthlySpent: null,
  exposure: null,
};
const gate = { userId: 7, subscriptionId: 1, amount: '2', allowPaygFallback: false };

describe('subscriptionAvailability', () => {
  it('owner 足额：返回额度余量', () => {
    expect(subscriptionAvailability(ownerSnapshot, gate).toString()).toBe('4');
  });

  it('无有效订阅 → Required（与开关无关）', () => {
    expect(() =>
      subscriptionAvailability({ ...ownerSnapshot, subscription: null }, { ...gate, allowPaygFallback: true }),
    ).toThrow(SubscriptionRequiredError);
  });

  it('非 owner 且无成员资格 → Forbidden', () => {
    expect(() =>
      subscriptionAvailability(
        { ...ownerSnapshot, subscription: { ...ownerSnapshot.subscription!, ownerId: 99 } },
        gate,
      ),
    ).toThrow(SubscriptionForbiddenError);
  });

  it('开关 OFF 额度不足 → QuotaExhausted 整单拒绝（= 存量行为）', () => {
    expect(() => subscriptionAvailability(ownerSnapshot, { ...gate, amount: '4.5' })).toThrow(
      SubscriptionQuotaExhaustedError,
    );
  });

  it('开关 ON 额度不足 → 返回余量（PAYG 补差的缺口）', () => {
    expect(
      subscriptionAvailability(ownerSnapshot, { ...gate, amount: '4.5', allowPaygFallback: true }).toString(),
    ).toBe('4');
  });

  it('成员限额封顶可用额；开关 OFF 时按 daily → monthly → quota 次序抛错', () => {
    const memberSnapshot = {
      subscription: { ...ownerSnapshot.subscription!, ownerId: 99, orgId: 3 },
      membership: { dailySpendLimit: '2', monthlyQuota: '10' },
      dailySpent: '1',
      monthlySpent: '1',
      exposure: '0',
    };
    // 日限余量 1 是最紧约束
    expect(
      subscriptionAvailability(memberSnapshot, { ...gate, allowPaygFallback: true }).toString(),
    ).toBe('1');
    // 开关 OFF 且需求超日限 → MemberDaily（即便额度也恰好不足，日限先判）
    expect(() =>
      subscriptionAvailability(memberSnapshot, { ...gate, amount: '4.5' }),
    ).toThrow(MemberDailyLimitExceededError);
  });

  it('负余量防御性 clamp：异常数据不产生负可用额', () => {
    const overdrawn = {
      ...ownerSnapshot,
      subscription: { ...ownerSnapshot.subscription!, usedAmount: '9', reservedAmount: '1' },
    };
    expect(subscriptionAvailability(overdrawn, { ...gate, allowPaygFallback: true }).toString()).toBe('0');
  });
});

describe('assertDailySpendLimit', () => {
  it('已结算 + 在途 + 本次 ≤ 限额 → 放行', () => {
    expect(() =>
      assertDailySpendLimit({ scope: 'user', userId: 1, limit: '10', spent: '5', exposure: '2', amount: '3' }),
    ).not.toThrow();
  });

  it('超限 → DailySpendLimitExceeded（user/key 双口径）', () => {
    expect(() =>
      assertDailySpendLimit({ scope: 'user', userId: 1, limit: '10', spent: '5', exposure: '2', amount: '3.1' }),
    ).toThrow(DailySpendLimitExceededError);
    expect(() =>
      assertDailySpendLimit({ scope: 'key', userId: 1, apiKeyId: 9, limit: '1', spent: '0', exposure: '0', amount: '2' }),
    ).toThrow(DailySpendLimitExceededError);
  });
});
