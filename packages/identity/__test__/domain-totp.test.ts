/**
 * TOTP 域测试(v1 totp.test 迁移):RFC 4648/6238 官方向量、往返、容错、
 * 窗口匹配、恢复码形状。
 */
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_LENGTH,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  hotp,
  matchingTotpStep,
  totpAt,
} from '../src/domain/totp.js';

describe('base32(RFC 4648)', () => {
  it('官方向量', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('Hello, world!'))).toBe('JBSWY3DPFQQHO33SNRSCC');
  });

  it('任意长度字节往返', () => {
    for (const len of [0, 1, 2, 5, 20, 64]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37) % 256));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it('大小写容忍、忽略填充、非法字符抛错', () => {
    expect(base32Decode('mzxw6y').equals(base32Decode('MZXW6Y'))).toBe(true);
    expect(() => base32Decode('MZXW6Y=')).not.toThrow();
    expect(() => base32Decode('M1XW6Y')).toThrow(/invalid base32/);
  });
});

describe('HOTP / TOTP(RFC 向量)', () => {
  it('RFC 6238 Appendix B:SHA1/8 位五时刻向量', () => {
    const seed = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [epochSec, expected] of vectors) {
      expect(totpAt(seed, epochSec * 1000, 30, 8)).toBe(expected);
    }
  });

  it('默认 6 位,前导零保留', () => {
    const code = hotp(Buffer.from('k'), 0, 6);
    expect(code).toMatch(/^[0-9]{6}$/);
  });
});

describe('matchingTotpStep 窗口语义', () => {
  const secret = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const stepMs = 30_000;
  const currentStep = 1_000_000;
  const at = (step: number) => step * stepMs;

  it('当前步命中,±1 窗口命中,±2 拒绝', () => {
    expect(
      matchingTotpStep(secret, totpAt(secret, at(currentStep), 30), at(currentStep), 30, 1),
    ).toBe(currentStep);
    expect(
      matchingTotpStep(secret, totpAt(secret, at(currentStep - 1), 30), at(currentStep), 30, 1),
    ).toBe(currentStep - 1);
    expect(
      matchingTotpStep(secret, totpAt(secret, at(currentStep + 1), 30), at(currentStep), 30, 1),
    ).toBe(currentStep + 1);
    expect(
      matchingTotpStep(secret, totpAt(secret, at(currentStep - 2), 30), at(currentStep), 30, 1),
    ).toBeNull();
    expect(
      matchingTotpStep(secret, totpAt(secret, at(currentStep + 2), 30), at(currentStep), 30, 1),
    ).toBeNull();
  });

  it('非数字码直接 null', () => {
    expect(matchingTotpStep(secret, 'abc', at(currentStep), 30, 1)).toBeNull();
    expect(matchingTotpStep(secret, '', at(currentStep), 30, 1)).toBeNull();
  });
});

// 模块级确定性字符选取器(字母表末位;不捕获父作用域,供恢复码形状测试复用)
const lastAlphabetChar = (alphabetLen: number) => alphabetLen - 1;

describe('恢复码', () => {
  it('10 位、字母表去 I/L/O/0/1', () => {
    const code = generateRecoveryCode(lastAlphabetChar);
    expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    expect(code).not.toMatch(/[ILO01]/);
  });
});
