/** 预扣策略（纯函数）：注册表分发 + fail-closed 校验 + 放行门与最严阈值。 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../wallet/money.js';
import { BillingConfigurationError } from '../errors.js';
import {
  admitsReservation,
  reservationStrategyOf,
  RESERVATION_STRATEGIES,
  strictestBalanceFloor,
} from '../reservation-strategy.js';

describe('预扣策略注册表', () => {
  it('full（缺省）：不干预——单位保底与余额阈值均 null（现行全额保守语义）', () => {
    expect(RESERVATION_STRATEGIES.full!.unitFloorOf({})).toBeNull();
    expect(RESERVATION_STRATEGIES.full!.balanceFloorOf({ params: { balance: '0.1' } })).toBeNull();
    expect(reservationStrategyOf({}).unitFloorOf({})).toBeNull(); // 未声明 = full
  });

  it('floor：units/balance 通用参数——视频≥5秒、图片≥1张、文本 0.1 放行同一策略', () => {
    const s = reservationStrategyOf({ strategy: 'floor', params: { units: 5, balance: '0.1' } });
    expect(s.unitFloorOf({ strategy: 'floor', params: { units: 5 } })).toBe(5);
    expect(s.balanceFloorOf({ strategy: 'floor', params: { balance: '0.1' } })).toBe('0.1');
    expect(s.unitFloorOf({ strategy: 'floor', params: {} })).toBeNull(); // 未配不干预
  });

  it('floor 非法参数 = 配置事故（fail-closed）：units 非正整数 / balance 非正金额', () => {
    expect(() => reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 0 } })).toThrow(BillingConfigurationError);
    expect(() => reservationStrategyOf({ strategy: 'floor' }).unitFloorOf({ params: { units: 2.5 } })).toThrow(BillingConfigurationError);
    expect(() => reservationStrategyOf({ strategy: 'floor' }).balanceFloorOf({ params: { balance: '0' } })).toThrow(BillingConfigurationError);
    expect(() => reservationStrategyOf({ strategy: 'floor' }).balanceFloorOf({ params: { balance: 'abc' } })).toThrow(BillingConfigurationError);
  });

  it('未知策略名 = 配置事故（fail-closed）', () => {
    expect(() => reservationStrategyOf({ strategy: 'nope' })).toThrow(BillingConfigurationError);
  });

  it('strictestBalanceFloor：候选链取最严（最大）；无声明为 null', () => {
    expect(
      strictestBalanceFloor([
        { reservation: { strategy: 'floor', params: { balance: '0.1' } } },
        { reservation: { strategy: 'floor', params: { balance: '0.5' } } },
        {},
      ]),
    ).toBe('0.5');
    expect(strictestBalanceFloor([{ reservation: { strategy: 'full' } }, {}])).toBeNull();
    expect(strictestBalanceFloor([])).toBeNull();
  });

  it('admitsReservation：未配阈值须足额；配置阈值实筹≥阈值即放行', () => {
    const required = new Decimal('2');
    expect(admitsReservation(null, new Decimal('1.9'), required)).toBe(false); // fail-closed
    expect(admitsReservation(null, new Decimal('2'), required)).toBe(true);
    expect(admitsReservation('0.1', new Decimal('0.15'), required)).toBe(true); // 小余额放行
    expect(admitsReservation('0.1', new Decimal('0.05'), required)).toBe(false); // 低于阈值拒绝
  });
});
