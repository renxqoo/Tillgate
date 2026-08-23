import { describe, expect, it } from 'vitest';
import { timingSafeTokenEqual } from '../src/security/token-compare';

/**
 * 常量时间令牌比较语义锁：等长逐字节、不等长必假、多字节 utf8。
 * (常量时间性本身不可移植断言——由实现逐字使用 node:crypto timingSafeEqual 保证;
 * 本用例锁住的是「不等长路径做哑比较后返回 false」与等长精确性两个可观察行为。)
 */
describe('timingSafeTokenEqual', () => {
  it('等长：相同为真，一字之差为假', () => {
    expect(timingSafeTokenEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
    expect(timingSafeTokenEqual('Bearer abc123', 'Bearer abc124')).toBe(false);
  });

  it('不等长：必假——含前缀、超长与空串形态', () => {
    expect(timingSafeTokenEqual('Bearer abc', 'Bearer abcdefgh')).toBe(false);
    expect(timingSafeTokenEqual('Bearer abcdefgh', 'Bearer abc')).toBe(false);
    expect(timingSafeTokenEqual('', 'Bearer abc')).toBe(false);
    expect(timingSafeTokenEqual('Bearer abc', '')).toBe(false);
  });

  it('空串对空串为真;多字节 utf8 按字节比较', () => {
    expect(timingSafeTokenEqual('', '')).toBe(true);
    expect(timingSafeTokenEqual('令牌-值', '令牌-值')).toBe(true);
    // '令' 与 '令' 视觉同形但码位不同( U+4EE4 vs U+4E8D 同形例外不构造,用确定不同码位)
    expect(timingSafeTokenEqual('令牌', '今牌')).toBe(false);
  });

  it('表驱动：交换律(比较对称)', () => {
    const pairs: ReadonlyArray<readonly [string, string, boolean]> = [
      ['t'.repeat(24), 't'.repeat(24), true],
      ['t'.repeat(24), 'u'.repeat(24), false],
      ['Bearer t'.repeat(3), 'Bearer t'.repeat(3), true],
    ];
    for (const [a, b, expected] of pairs) {
      expect(timingSafeTokenEqual(a, b)).toBe(expected);
      expect(timingSafeTokenEqual(b, a)).toBe(expected);
    }
  });
});
