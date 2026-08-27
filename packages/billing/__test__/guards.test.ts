/**
 * fail-closed 白名单守卫（表驱动矩阵：新增词表项自动获得覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import {
  assertCurrency,
  assertInternalCode,
  assertRefId,
  assertRefType,
  type WalletGuards,
} from '../src/domain/wallet/guards.js';

const guards: WalletGuards = {
  refTypes: ['billing', 'topup'],
  currencies: ['CNY', 'USD'],
  internalAccounts: ['outside', 'platform_revenue'],
};

function rejection(fn: () => void): { code: string; context: Record<string, unknown> } {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error('expected business rejection');
  return {
    code: (caught as { code: string }).code,
    context: (caught as { context?: Record<string, unknown> }).context ?? {},
  };
}

describe('白名单守卫（fail-closed）', () => {
  it('声明的词全部放行', () => {
    expect(() => assertRefType(guards, 'billing')).not.toThrow();
    expect(() => assertCurrency(guards, 'CNY')).not.toThrow();
    expect(() => assertInternalCode(guards, 'outside')).not.toThrow();
  });

  it('未声明/拼错一律拒绝，reason 入 context（表驱动）', () => {
    const cases: Array<[() => void, string, Record<string, unknown>]> = [
      [() => assertRefType(guards, 'billingg'), 'invalid_ref_type', { refType: 'billingg' }],
      [() => assertCurrency(guards, 'cny'), 'invalid_currency', { currency: 'cny' }],
      [
        () => assertInternalCode(guards, 'platfrom_revenue'),
        'invalid_internal_code',
        { code: 'platfrom_revenue' },
      ],
    ];
    for (const [fn, reason, context] of cases) {
      const rejection0 = rejection(fn);
      expect(rejection0.code).toBe('billing.invalid_ref');
      expect(rejection0.context).toEqual({ reason, ...context });
    }
  });

  it('refId 契约：1-128 字符', () => {
    expect(() => assertRefId('a')).not.toThrow();
    expect(() => assertRefId('a'.repeat(128))).not.toThrow();
    const empty = rejection(() => assertRefId(''));
    expect(empty.context).toEqual({ reason: 'invalid_ref_id', length: 0 });
    const tooLong = rejection(() => assertRefId('a'.repeat(129)));
    expect(tooLong.context).toEqual({ reason: 'invalid_ref_id', length: 129 });
  });
});
