/** TOTP 纯函数：RFC 4648 base32 + RFC 6238 官方测试向量（SHA1/8 位）+ 窗口匹配语义 */
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_LENGTH,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  matchingTotpStep,
  totpAt,
} from '../totp';

/** RFC 6238 Appendix B 的 SHA1 种子（ASCII '12345678901234567890'） */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32', () => {
  it('RFC 4648 向量：ASCII 种子 ↔ GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString('ascii')).toBe(
      '12345678901234567890',
    );
  });

  it('任意字节往返（含非整 5 位长度）', () => {
    for (const len of [1, 2, 5, 19, 20, 32]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it('大小写不敏感、容忍填充；非法字符抛错', () => {
    expect(base32Decode('gezd gnbv='.replace(' ', '')).length).toBeGreaterThan(0);
    expect(() => base32Decode('1!')).toThrow(/invalid base32/);
  });
});

describe('totpAt（RFC 6238 Appendix B，SHA1 / 8 位）', () => {
  const cases: Array<[epochSec: number, expected: string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [epochSec, expected] of cases) {
    it(`T=${epochSec} → ${expected}`, () => {
      expect(totpAt(RFC_SECRET, epochSec * 1000, 30, 8)).toBe(expected);
    });
  }

  it('默认 6 位 + 前导零保留', () => {
    const code = totpAt(RFC_SECRET, 59_000, 30);
    expect(code).toMatch(/^[0-9]{6}$/);
  });
});

describe('matchingTotpStep（窗口匹配 + 单调锚点选择）', () => {
  const stepSec = 30;
  const baseMs = 1_700_000_000_000;
  const current = Math.floor(baseMs / 1000 / stepSec);

  it('当前步命中 → 返回当前步', () => {
    const code = totpAt(RFC_SECRET, baseMs, stepSec);
    expect(matchingTotpStep(RFC_SECRET, code, baseMs, stepSec, 1)).toBe(current);
  });

  it('上一步/下一步（窗口 ±1）命中 → 返回对应步', () => {
    const prevCode = totpAt(RFC_SECRET, (current - 1) * stepSec * 1000, stepSec);
    const nextCode = totpAt(RFC_SECRET, (current + 1) * stepSec * 1000, stepSec);
    expect(matchingTotpStep(RFC_SECRET, prevCode, baseMs, stepSec, 1)).toBe(current - 1);
    expect(matchingTotpStep(RFC_SECRET, nextCode, baseMs, stepSec, 1)).toBe(current + 1);
  });

  it('窗口外（±2 步）不命中', () => {
    const farCode = totpAt(RFC_SECRET, (current + 2) * stepSec * 1000, stepSec);
    expect(matchingTotpStep(RFC_SECRET, farCode, baseMs, stepSec, 1)).toBeNull();
  });

  it('非数字码直接 null（不进 HMAC 比较）', () => {
    expect(matchingTotpStep(RFC_SECRET, 'abcdef', baseMs, stepSec, 1)).toBeNull();
    expect(matchingTotpStep(RFC_SECRET, '', baseMs, stepSec, 1)).toBeNull();
  });
});

describe('generateRecoveryCode', () => {
  it('10 位、去易混字母表、crypto 随机分布（去重抽样）', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const code = generateRecoveryCode((n) => i % n);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(1);
  });
});
