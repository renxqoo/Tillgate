import { describe, expect, it } from 'vitest';
import { createCipher } from '../../src/crypto/cipher';

/** 单 key 单格式语义：enc:v1 是格式标记（非密钥世代）；错误密钥/篡改一律认证失败。 */
const K = 'encryption-key-32-chars-minimum!!';

describe('AES-GCM 单 key（createCipher）', () => {
  it('加解密往返（enc:v1 格式稳定——存量行不受影响）', () => {
    const cipher = createCipher(K);
    const packed = cipher.encrypt('secret-upstream-key');
    expect(packed.startsWith('enc:v1:')).toBe(true);
    expect(cipher.decrypt(packed)).toBe('secret-upstream-key');
  });

  it('每次加密 iv 随机（同明文两次密文不同）', () => {
    const cipher = createCipher(K);
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('错误密钥 → GCM 认证失败（不静默解出垃圾）', () => {
    const packed = createCipher(K).encrypt('secret');
    expect(() => createCipher('wrong-key-32-chars-minimum!!!!').decrypt(packed)).toThrow();
  });

  it('篡改密文 → 认证失败', () => {
    const cipher = createCipher(K);
    const packed = cipher.encrypt('x');
    const tampered = packed.slice(0, -4) + '0000';
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('非法格式拒绝（段数/前缀/世代标记）', () => {
    const cipher = createCipher(K);
    expect(() => cipher.decrypt('not-packed')).toThrow(/invalid ciphertext format/);
    expect(() => cipher.decrypt('enc:v2:aa:bb:cc')).toThrow(/invalid ciphertext format/);
  });

  it('iv / tag 段长度畸形拒绝（hex 解码后长度不符）', () => {
    const cipher = createCipher(K);
    const packed = cipher.encrypt('x');
    const parts = packed.split(':');
    // iv 段砍成 11 字节 hex
    const badIv = ['enc', 'v1', parts[2]!.slice(0, 22), parts[3], parts[4]].join(':');
    expect(() => cipher.decrypt(badIv)).toThrow(/invalid iv length/);
    // tag 段砍成 15 字节 hex
    const badTag = ['enc', 'v1', parts[2], parts[3]!.slice(0, 30), parts[4]].join(':');
    expect(() => cipher.decrypt(badTag)).toThrow(/invalid tag length/);
  });
});
