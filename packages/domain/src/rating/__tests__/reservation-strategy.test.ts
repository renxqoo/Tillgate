/** 预扣策略（纯函数）：只能抬高计量单位，不得降低资金预留。 */
import { describe, expect, it } from 'vitest';
import { BillingConfigurationError } from '../errors.js';
import {
  reservationStrategyOf,
  RESERVATION_STRATEGIES,
} from '../reservation-strategy.js';
import { calculateFundingReservation } from '../calculate.js';

describe('预扣策略注册表', () => {
  it('full（缺省）：不干预单位保底', () => {
    expect(RESERVATION_STRATEGIES.full!.unitFloorOf({})).toBeNull();
    expect(reservationStrategyOf({}).unitFloorOf({})).toBeNull(); // 未声明 = full
  });

  it('floor：只支持 units 单位保底', () => {
    const s = reservationStrategyOf({ strategy: 'floor', params: { units: 5 } });
    expect(s.unitFloorOf({ strategy: 'floor', params: { units: 5 } })).toBe(5);
    expect(s.unitFloorOf({ strategy: 'floor', params: {} })).toBeNull(); // 未配不干预
  });

  it('floor 非法 units = 配置事故（fail-closed）', () => {
    expect(() => reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 0 } })).toThrow(BillingConfigurationError);
    expect(() => reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 2.5 } })).toThrow(BillingConfigurationError);
  });

  it('未知策略名 = 配置事故（fail-closed）', () => {
    expect(() => reservationStrategyOf({ strategy: 'nope' })).toThrow(BillingConfigurationError);
  });

});

describe('资金预扣金额策略', () => {
  it('full（缺省）冻结完整风险预估', () => {
    expect(calculateFundingReservation('12.5', { mode: 'full' }).toString()).toBe('12.5');
  });

  it('fixed 对付费请求冻结固定金额，实际风险预估保持独立', () => {
    expect(
      calculateFundingReservation('12.5', { mode: 'fixed', amount: '0.01' }).toString(),
    ).toBe('0.01');
  });

  it('免费请求不因 fixed 策略产生预扣', () => {
    expect(
      calculateFundingReservation('0', { mode: 'fixed', amount: '0.01' }).toString(),
    ).toBe('0');
  });

  it('fixed 缺金额或金额非正数必须 fail-closed', () => {
    expect(() => calculateFundingReservation('1', { mode: 'fixed' })).toThrow(
      BillingConfigurationError,
    );
    expect(() =>
      calculateFundingReservation('1', { mode: 'fixed', amount: '0' }),
    ).toThrow(BillingConfigurationError);
  });
});
