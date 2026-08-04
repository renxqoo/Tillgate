import { describe, expect, it } from 'vitest';
import { liToYuan, yuanToLi } from '../../src/units.js';

describe('单位换算', () => {
  it('厘 → 元（展示，两位小数）', () => {
    expect(liToYuan(1000)).toBe('1.00');
    expect(liToYuan(1050)).toBe('1.05');
    expect(liToYuan(1)).toBe('0.00');
  });

  it('元 → 厘（四舍五入）', () => {
    expect(yuanToLi(1)).toBe(1000);
    expect(yuanToLi(1.5)).toBe(1500);
    expect(yuanToLi(0.001)).toBe(1);
    expect(yuanToLi(0.0004)).toBe(0);
  });
});
