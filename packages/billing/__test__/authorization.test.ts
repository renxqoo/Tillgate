/**
 * 冻结单状态机守卫行为规格（旧仓经 service 集成测试间接覆盖；U1a 起以纯函数直测锁死
 * 状态机分岔——U1b 的 CAS 语义依赖这些断言）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { Decimal } from '../src/domain/money.js';
import {
  assertReleasable,
  assertSettleable,
  type AuthorizationSnapshot,
} from '../src/domain/wallet/authorization.js';

const now = new Date('2026-08-23T00:00:00Z');
const future = new Date('2026-08-23T01:00:00Z');

function auth(overrides: Partial<AuthorizationSnapshot> = {}): AuthorizationSnapshot {
  return {
    id: 'auth-1',
    accountId: 'acc-1',
    refType: 'billing',
    refId: 'req-1',
    amount: '5',
    status: 'active',
    settledAmount: null,
    authorizeFingerprint: null,
    expiresAt: future,
    ...overrides,
  };
}

function expectCode(fn: () => void, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error(`expected business rejection (${code})`);
  expect((caught as { code: string }).code).toBe(code);
}

describe('assertSettleable（结算前置）', () => {
  it('active 且未过期且实扣 ≤ 冻结额 → 通过（恰好等额也通过）', () => {
    expect(() => assertSettleable(auth(), new Decimal('5'), now)).not.toThrow();
  });

  it('非 active 拒绝（status 入 context，重放分岔依据）', () => {
    expectCode(
      () => assertSettleable(auth({ status: 'released' }), new Decimal('1'), now),
      'billing.authorization_not_active',
    );
    expectCode(
      () => assertSettleable(auth({ status: 'settled' }), new Decimal('1'), now),
      'billing.authorization_not_active',
    );
  });

  it('expiresAt 是权威截止：到期即拒绝且 status 报 expired（worker 延迟不许过期后 settle）', () => {
    expectCode(
      () => assertSettleable(auth({ expiresAt: now }), new Decimal('1'), now),
      'billing.authorization_not_active',
    );
  });

  it('实扣 > 冻结额拒绝（settle ≤ hold 是内核保证）', () => {
    expectCode(
      () => assertSettleable(auth(), new Decimal('5.000000000000000001'), now),
      'billing.settle_exceeds_hold',
    );
  });

  it('无过期时间（billing 授权恒 expiresAt=null）不受截止约束', () => {
    expect(() => assertSettleable(auth({ expiresAt: null }), new Decimal('5'), now)).not.toThrow();
  });
});

describe('assertReleasable（释放前置）', () => {
  it('仅 active 可释放；终态一律拒绝', () => {
    expect(() => assertReleasable(auth())).not.toThrow();
    expectCode(
      () => assertReleasable(auth({ status: 'settled' })),
      'billing.authorization_not_active',
    );
    expectCode(
      () => assertReleasable(auth({ status: 'expired' })),
      'billing.authorization_not_active',
    );
  });
});
