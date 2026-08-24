/**
 * 字段域与限额域:表驱动边界矩阵(§10.1-4)。
 * v1 语义锚:金额结构性拒绝科学计数法/22 位整数/负数/NaN/超 1e12 上界。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeEmail,
  isValidEmail,
  normalizeValidEmail,
  normalizeName,
  clampOptionalText,
  FIELD_LIMITS,
} from '../src/domain/fields.js';
import {
  parseAmountLimit,
  parseRateLimit,
  isPositiveAmount,
  isNonNegativeAmountWithin,
} from '../src/domain/limits.js';
import {
  localDisplayNameFallback,
  oauthDisplayNameFallback,
  clampDisplayName,
} from '../src/domain/user.js';

const UPPER = '1000000000000'; // v1 等价上界

describe('email 规范化与校验', () => {
  it('trim + 小写(v1 大小写归一口径)', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });
  it.each([
    ['a@b.co', true],
    ['alice@example.com', true],
    ['ab@c', false], // 无 TLD 点
    ['a b@c.d', false], // 空格
    ['no-at-sign', false],
    ['', false],
    [`${'x'.repeat(251)}@d.co`, false], // 总长 256 > 255
  ])('isValidEmail(%s) = %s', (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });
  it('normalizeValidEmail 不合法返回 null', () => {
    expect(normalizeValidEmail(' ok@x.io ')).toBe('ok@x.io');
    expect(normalizeValidEmail('bad')).toBeNull();
  });
});

describe('名称域(trim 后 1..64)', () => {
  it('合法与边界', () => {
    expect(normalizeName('  key one  ')).toBe('key one');
    expect(normalizeName('a')).toBe('a');
    expect(normalizeName('x'.repeat(64))).toBe('x'.repeat(64));
  });
  it.each([[''], ['   '], ['x'.repeat(65)]])('normalizeName(%j) 拒绝', (input) => {
    expect(normalizeName(input)).toBeNull();
  });
  it('可空文本 clamp:超长判非法,显式 null 分支归调用方', () => {
    expect(clampOptionalText(' r ', 255)).toBe('r');
    expect(clampOptionalText('x'.repeat(256), 255)).toBeNull();
  });
});

describe('金额上限域(v1 结构性拒绝锚)', () => {
  it.each([
    ['10', '10'],
    ['0.000000000001', '0.000000000001'],
    ['1000000000000', '1000000000000'], // 恰上界
    ['0.1', '0.1'],
  ])('parseAmountLimit(%s) 合法', (input, expected) => {
    expect(parseAmountLimit(input, UPPER)).toBe(expected);
  });
  it.each([
    ['0'], // 零不是正上限
    ['-1'],
    ['1e21'], // 科学计数法
    ['1E5'],
    ['NaN'],
    ['Infinity'],
    ['abc'],
    ['1.2.3'],
    [''], // 22 位整数
    ['1234567890123456789012'],
    ['1000000000001'], // 超上界
    [' 10'], // 空白(正则拒绝,归一化是调用方责任)
  ])('parseAmountLimit(%j) 拒绝', (input) => {
    expect(parseAmountLimit(input as string, UPPER)).toBeNull();
  });
  it('isPositiveAmount 不允许 0;isNonNegativeAmountWithin 允许 0 且受上界约束', () => {
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('0.5')).toBe(true);
    expect(isNonNegativeAmountWithin('0', UPPER)).toBe(true);
    expect(isNonNegativeAmountWithin('5', UPPER)).toBe(true);
    expect(isNonNegativeAmountWithin('1000000000000', UPPER)).toBe(true); // 恰上界
    expect(isNonNegativeAmountWithin('-0.1', UPPER)).toBe(false);
    expect(isNonNegativeAmountWithin('1e2', UPPER)).toBe(false);
    expect(isNonNegativeAmountWithin('1000000000001', UPPER)).toBe(false);
  });
});

describe('频率限额域(正整数 ≤ max)', () => {
  it('合法:1 与上界', () => {
    expect(parseRateLimit(1, 1_000_000)).toBe(1);
    expect(parseRateLimit(1_000_000, 1_000_000)).toBe(1_000_000);
  });
  it.each([0, -1, 1.5, Number.NaN, 1_000_001])('parseRateLimit(%d) 拒绝', (input) => {
    expect(parseRateLimit(input, 1_000_000)).toBeNull();
  });
});

describe('显示名兜底派生(v1 语义)', () => {
  it('本地:email 本地部分截 64', () => {
    expect(localDisplayNameFallback('alice@example.com')).toBe('alice');
    expect(localDisplayNameFallback(`${'x'.repeat(80)}@d.co`)).toHaveLength(64);
    expect(localDisplayNameFallback('weird')).toBe('weird'); // 无 @ 全量
  });
  it('OAuth:「用户{subject 前 6}」截 64', () => {
    expect(oauthDisplayNameFallback('12345678')).toBe('用户123456');
    expect(oauthDisplayNameFallback('短')).toBe('用户短');
  });
  it('clampDisplayName trim + 截 64(兜底专用,不拒绝)', () => {
    expect(clampDisplayName('  ab  ')).toBe('ab');
    expect(clampDisplayName('y'.repeat(70))).toHaveLength(64);
  });
  it('FIELD_LIMITS 与 DDL varchar 镜像', () => {
    expect(FIELD_LIMITS).toEqual({
      email: 255,
      displayName: 64,
      name: 64,
      remark: 255,
      description: 255,
      freezeReason: 128,
      affCode: 32,
      token: 64,
      modelId: 64,
    });
  });
});
