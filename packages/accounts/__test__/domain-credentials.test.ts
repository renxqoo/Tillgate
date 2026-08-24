/**
 * 凭证材料生成(http 迁入后的单一真相;§10.1 契约 + 随机性)。
 */
import { describe, expect, it } from 'vitest';
import {
  sha256Hex,
  generateKeyMaterial,
  generateAppCredentials,
  maskKey,
  isValidKeyPrefix,
} from '../src/domain/credentials.js';

describe('sha256Hex(v1 标准向量)', () => {
  it('空串向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('长度恒 64 hex 且确定', () => {
    expect(sha256Hex('abc')).toHaveLength(64);
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });
});

describe('generateKeyMaterial(prefix 必填注入,B5)', () => {
  it('明文 = prefix + 40 hex(160 bit 熵);hash = SHA-256(明文)', () => {
    const m = generateKeyMaterial('sk_');
    expect(m.plaintext).toMatch(/^sk_[0-9a-f]{40}$/);
    expect(m.keyHash).toBe(sha256Hex(m.plaintext));
  });
  it('前缀按注入变化(与网关分派端同 env)', () => {
    expect(generateKeyMaterial('tk-').plaintext.startsWith('tk-')).toBe(true);
  });
  it('两次生成不相等', () => {
    expect(generateKeyMaterial('sk_').plaintext).not.toBe(generateKeyMaterial('sk_').plaintext);
  });
});

describe('maskKey(前 3 + **** + 末 4)', () => {
  it('标准形态', () => {
    expect(maskKey('sk_abcdef0123456789xyz')).toBe('sk_****9xyz');
  });
  it.each(['short', '12345678'])('短输入(%s)→ ****', (input) => {
    expect(maskKey(input)).toBe('****');
  });
  it('恰 9 字符边界正常脱敏', () => {
    expect(maskKey('123456789')).toBe('123****6789');
  });
});

describe('generateAppCredentials', () => {
  it('appId 32hex / clientId app_+16hex / secret 48hex,hash=SHA-256(secret)', () => {
    const c = generateAppCredentials();
    expect(c.appId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.clientId).toMatch(/^app_[0-9a-f]{16}$/);
    expect(c.clientSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(c.clientSecretHash).toBe(sha256Hex(c.clientSecret));
  });
  it('两次生成全量不等', () => {
    const a = generateAppCredentials();
    const b = generateAppCredentials();
    expect(a.appId).not.toBe(b.appId);
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.clientSecret).not.toBe(b.clientSecret);
  });
});

describe('Key 前缀词表(v1 env 约束)', () => {
  it.each(['sk_', 'tk-', 'a1', 'x-y_z9'])('%s 合法', (p) => {
    expect(isValidKeyPrefix(p)).toBe(true);
  });
  it.each(['a', 'Sk_', '1a_', '_sk', 'sk$x', 'a'.repeat(17)])('%s 非法', (p) => {
    expect(isValidKeyPrefix(p)).toBe(false);
  });
});
