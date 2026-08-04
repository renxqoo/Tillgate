import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password (scrypt)', () => {
  it('哈希结果包含 scrypt 前缀与 N/r/p 参数', async () => {
    const h = await hashPassword('Passw0rd!');
    expect(h.startsWith('scrypt:')).toBe(true);
    const parts = h.split(':');
    expect(parts).toHaveLength(6);
    expect(parts[1]).toBe('32768'); // 2^15
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    // salt + hash 各 32 字节 hex
    expect(parts[4]!.length).toBe(32); // 16 bytes → 32 hex
    expect(parts[5]!.length).toBe(64); // 32 bytes → 64 hex
  });

  it('两次哈希同密码 → salt 不同 → 哈希不同（带盐）', async () => {
    const a = await hashPassword('Same!');
    const b = await hashPassword('Same!');
    expect(a).not.toBe(b);
  });

  it('正确密码 → verify true', async () => {
    const h = await hashPassword('Correct-Pass-123');
    await expect(verifyPassword('Correct-Pass-123', h)).resolves.toBe(true);
  });

  it('错误密码 → verify false', async () => {
    const h = await hashPassword('right');
    await expect(verifyPassword('wrong', h)).resolves.toBe(false);
  });

  it('空 stored → false（无密码用户拒绝登录）', async () => {
    await expect(verifyPassword('whatever', null)).resolves.toBe(false);
    await expect(verifyPassword('whatever', undefined)).resolves.toBe(false);
    await expect(verifyPassword('whatever', '')).resolves.toBe(false);
  });

  it('格式非法的 stored → false（不抛错）', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt:foo')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt:bad:parts')).resolves.toBe(false);
  });

  it('参数不合法的 stored → false', async () => {
    await expect(verifyPassword('x', 'scrypt:0:8:1:ab:cd')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt:abc:8:1:ab:cd')).resolves.toBe(false);
  });

  it('大小写敏感', async () => {
    const h = await hashPassword('SecretPass');
    await expect(verifyPassword('secretpass', h)).resolves.toBe(false);
  });

  it('长密码（256 字符）可正常哈希与校验', async () => {
    const long = 'a'.repeat(256);
    const h = await hashPassword(long);
    await expect(verifyPassword(long, h)).resolves.toBe(true);
  });
});
