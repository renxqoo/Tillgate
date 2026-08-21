/** 渠道敞口预留决策（纯函数）：covered / topup / switch 三模式。 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../wallet/money.js';
import { budgetRemaining, reserveDecision } from '../reserve-rule.js';

describe('reserveDecision', () => {
  it('同渠道且新预估 ≤ 已预留 → covered（零变更）', () => {
    expect(
      reserveDecision({ currentChannelId: 3, currentReserved: '2', channelId: 3, amount: new Decimal('1.5') }),
    ).toEqual({ mode: 'covered' });
  });

  it('同渠道但预估更高 → topup 按差额补足', () => {
    expect(
      reserveDecision({ currentChannelId: 3, currentReserved: '2', channelId: 3, amount: new Decimal('2.5') }),
    ).toEqual({ mode: 'topup', delta: '0.5' });
  });

  it('不同渠道 / 首次预留（无认领）→ switch', () => {
    expect(
      reserveDecision({ currentChannelId: null, currentReserved: null, channelId: 3, amount: new Decimal('1') }),
    ).toEqual({ mode: 'switch' });
    expect(
      reserveDecision({ currentChannelId: 1, currentReserved: '2', channelId: 2, amount: new Decimal('1') }),
    ).toEqual({ mode: 'switch' });
  });
});

describe('budgetRemaining', () => {
  it('进货额度 − 在途敞口', () => {
    expect(budgetRemaining('10', '2.5')).toBe('7.5');
  });
});
