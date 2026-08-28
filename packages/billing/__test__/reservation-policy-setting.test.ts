/**
 * 预扣策略 KV 值域解析：full 原样 / fixed 需正金额 / 形状与垃圾值 → null
 * （未配置语义 = 消费方回落 full，fail-closed 不放大放行）。
 */
import { describe, expect, it } from 'vitest';
import { parseReservationPolicySetting } from '../src/application/billing/reservation-policy';

describe('parseReservationPolicySetting', () => {
  it('full 原样通过（含省略 amount）', () => {
    expect(parseReservationPolicySetting({ mode: 'full' })).toEqual({ mode: 'full' });
    expect(parseReservationPolicySetting({ mode: 'full', amount: '0.01' })).toEqual({
      mode: 'full',
    });
  });

  it('fixed + 正金额通过（表驱动）', () => {
    for (const amount of ['0.01', '1', '100.555', '0.000001']) {
      expect(parseReservationPolicySetting({ mode: 'fixed', amount })).toEqual({
        mode: 'fixed',
        amount,
      });
    }
  });

  it('fixed + 零/负/垃圾金额 → null（零门槛 = 无限放行，禁）', () => {
    for (const amount of ['0', '0.00', '-1', 'abc', '', '1e3件']) {
      expect(parseReservationPolicySetting({ mode: 'fixed', amount })).toBeNull();
    }
  });

  it('形状异常/未知模式/null → null（表驱动）', () => {
    for (const raw of [
      null,
      undefined,
      'fixed',
      42,
      {},
      { mode: 'other' },
      { mode: 'fixed' },
      { mode: 1, amount: '1' },
    ]) {
      expect(parseReservationPolicySetting(raw)).toBeNull();
    }
  });
});
