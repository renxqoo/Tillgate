import { describe, expect, it } from 'vitest';

import { CATEGORY_DEFAULTS, ERROR_CATEGORIES, isErrorCategory } from '../src/category';

/** 词表封闭锁：闭集与文档词表逐项一致，默认表无缺无余 */
describe('category 闭集', () => {
  it('闭集 == 文档词表七项（硬编码对照，增删必须先改 ADR）', () => {
    expect([...ERROR_CATEGORIES]).toEqual([
      'invalid_input',
      'not_found',
      'conflict',
      'forbidden',
      'quota_exhausted',
      'rate_limited',
      'unavailable',
    ]);
  });

  it('闭集无重复', () => {
    expect(new Set(ERROR_CATEGORIES).size).toBe(ERROR_CATEGORIES.length);
  });

  it('CATEGORY_DEFAULTS 键集合与闭集完全一致（无缺无余）', () => {
    expect(Object.keys(CATEGORY_DEFAULTS).toSorted()).toEqual([...ERROR_CATEGORIES].toSorted());
  });

  it('处理语义默认与文档矩阵逐项一致', () => {
    expect(CATEGORY_DEFAULTS.invalid_input).toEqual({ retryable: false, alert: false });
    expect(CATEGORY_DEFAULTS.not_found).toEqual({ retryable: false, alert: false });
    expect(CATEGORY_DEFAULTS.conflict).toEqual({ retryable: false, alert: false });
    expect(CATEGORY_DEFAULTS.forbidden).toEqual({ retryable: false, alert: false });
    expect(CATEGORY_DEFAULTS.quota_exhausted).toEqual({ retryable: false, alert: false });
    expect(CATEGORY_DEFAULTS.rate_limited).toEqual({ retryable: true, alert: false });
    expect(CATEGORY_DEFAULTS.unavailable).toEqual({ retryable: true, alert: true });
  });

  it('默认表冻结（装配后不可变）', () => {
    expect(Object.isFrozen(CATEGORY_DEFAULTS)).toBe(true);
  });

  it('isErrorCategory：闭集全真，其余全假', () => {
    for (const c of ERROR_CATEGORIES) expect(isErrorCategory(c)).toBe(true);
    for (const v of ['foo', 'Invalid_Input', 'QUOTA_EXHAUSTED', '', 42, null, undefined, {}]) {
      expect(isErrorCategory(v)).toBe(false);
    }
  });
});
