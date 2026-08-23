import { describe, expect, it } from 'vitest';
import { DefectError, isDefectError } from '@tokenlens/errors';
import { createCipher } from '../src/crypto/cipher';

/** 单 key 单格式语义：enc:v1 是格式标记（非密钥世代）；错误密钥/篡改一律认证失败。 */
const K = 'encryption-key-32-chars-minimum!!';

/** 断言抛出根契约身份与码（§11：runtime 基础设施/缺陷错误就地分类） */
function expectDefect(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected DefectError (${code})`);
  } catch (e) {
    expect(isDefectError(e), String(e)).toBe(true);
    expect((e as DefectError).code).toBe(code);
  }
}

describe('AES-GCM 单 key（createCipher）', () => {
  it('P3 回归：空密钥 fail-fast（DefectError empty_key——SHA-256 不得把空串安静派生成合法 key）', () => {
    expectDefect(() => createCipher(''), 'runtime.cipher.empty_key');
  });

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

  it('错误密钥 → GCM 认证失败（DefectError auth_failed，不静默解出垃圾）', () => {
    const packed = createCipher(K).encrypt('secret');
    expectDefect(
      () => createCipher('wrong-key-32-chars-minimum!!!!').decrypt(packed),
      'runtime.cipher.auth_failed',
    );
  });

  it('篡改密文 → 认证失败（DefectError auth_failed，保留原生 cause）', () => {
    const cipher = createCipher(K);
    // 明文须长于 2 字节：GCM 是流密码（密文=明文长），单字节明文的 cipher 段只有
    // 2 个 hex 字符，末 4 字符篡改会破坏段结构而非走认证路径（v1 泛断言曾掩盖此点）
    const packed = cipher.encrypt('tamper-target-payload-0123456789');
    const tampered = packed.slice(0, -4) + '0000';
    try {
      cipher.decrypt(tampered);
      expect.unreachable('expected auth failure');
    } catch (e) {
      expect(isDefectError(e)).toBe(true);
      expect((e as DefectError).code).toBe('runtime.cipher.auth_failed');
      expect((e as DefectError).cause).toBeInstanceOf(Error); // 原生 GCM 失败在 cause 链
    }
  });

  it('非法格式拒绝（段数/前缀/世代标记 → DefectError invalid_format）', () => {
    const cipher = createCipher(K);
    expectDefect(() => cipher.decrypt('not-packed'), 'runtime.cipher.invalid_format');
    expectDefect(() => cipher.decrypt('enc:v2:aa:bb:cc'), 'runtime.cipher.invalid_format');
  });

  it('iv / tag 段长度畸形拒绝（hex 解码后长度不符 → invalid_format）', () => {
    const cipher = createCipher(K);
    const packed = cipher.encrypt('x');
    const parts = packed.split(':');
    // iv 段砍成 11 字节 hex
    const badIv = ['enc', 'v1', parts[2]!.slice(0, 22), parts[3], parts[4]].join(':');
    expectDefect(() => cipher.decrypt(badIv), 'runtime.cipher.invalid_format');
    // tag 段砍成 15 字节 hex
    const badTag = ['enc', 'v1', parts[2], parts[3]!.slice(0, 30), parts[4]].join(':');
    expectDefect(() => cipher.decrypt(badTag), 'runtime.cipher.invalid_format');
  });
});
