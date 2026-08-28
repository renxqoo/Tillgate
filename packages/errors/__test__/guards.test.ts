import { describe, expect, it } from 'vitest';

import { defineErrorCatalog } from '../src/definition';
import {
  isBusinessError,
  isDefectError,
  isInfrastructureError,
  isTillgateError,
} from '../src/guards';
import { DefectError, InfrastructureError } from '../src/nature';

const GuardErrors = defineErrorCatalog('guardtest', {
  denied: { category: 'conflict', message: 'm', zh: '中' },
});

/** 守卫面：middleware/边界层精确捕获的唯一入口 */
describe('instanceof 守卫', () => {
  const business = GuardErrors.business('denied');
  const infra = new InfrastructureError('m', 'a.b');
  const defect = new DefectError('m', 'a.b');

  it('isTillgateError：三性全真，外来 Error/非错误值假', () => {
    for (const e of [business, infra, defect]) expect(isTillgateError(e)).toBe(true);
    expect(isTillgateError(new Error('m'))).toBe(false);
    expect(isTillgateError('boom')).toBe(false);
    expect(isTillgateError(null)).toBe(false);
  });

  it('isBusinessError / isInfrastructureError / isDefectError 三值互斥', () => {
    expect(isBusinessError(business)).toBe(true);
    expect(isBusinessError(infra)).toBe(false);
    expect(isBusinessError(defect)).toBe(false);
    expect(isInfrastructureError(infra)).toBe(true);
    expect(isInfrastructureError(business)).toBe(false);
    expect(isDefectError(defect)).toBe(true);
    expect(isDefectError(business)).toBe(false);
  });
});
