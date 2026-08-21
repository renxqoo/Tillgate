import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../crypto.js';

/** 单 key 单格式语义：enc:v1 是格式标记（非密钥世代）；错误密钥/篡改一律认证失败。 */
const K = 'encryption-key-32-chars-minimum!!';

describe('AES-GCM 单 key', () => {
  it('加解密往返（enc:v1 格式稳定——存量行不受影响）', () => {
    const packed = encrypt('secret-upstream-key', K);
    expect(packed.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(packed, K)).toBe('secret-upstream-key');
  });

  it('每次加密 iv 随机（同明文两次密文不同）', () => {
    expect(encrypt('same', K)).not.toBe(encrypt('same', K));
  });

  it('错误密钥 → GCM 认证失败（不静默解出垃圾）', () => {
    const packed = encrypt('secret', K);
    expect(() => decrypt(packed, 'wrong-key-32-chars-minimum!!!!')).toThrow();
  });

  it('篡改密文 → 认证失败', () => {
    const packed = encrypt('x', K);
    const tampered = packed.slice(0, -4) + '0000';
    expect(() => decrypt(tampered, K)).toThrow();
  });

  it('非法格式拒绝（段数/前缀/世代标记）', () => {
    expect(() => decrypt('not-packed', K)).toThrow(/invalid ciphertext format/);
    expect(() => decrypt('enc:v2:aa:bb:cc', K)).toThrow(/invalid ciphertext format/);
  });
});
