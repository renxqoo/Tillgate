/** 密码哈希纯函数：往返/格式兼容（legacy 同格式）/自描述参数/哑哈希防枚举/策略 */
import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_HASH_RE,
  assertPasswordPolicy,
  hashPassword,
  resolvePasswordPolicy,
  verifyPassword,
  SCRYPT_N,
} from '../password';
import { WeakPasswordError } from '../errors';

describe('hashPassword / verifyPassword', () => {
  it('往返：正确密码通过、错误密码拒绝', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('存储格式：scrypt:N:r:p:<saltHex>:<hashHex>（与 gateway 旧 identity 包逐字兼容）', async () => {
    const stored = await hashPassword('pw');
    expect(stored.startsWith(`scrypt:${SCRYPT_N}:8:1:`)).toBe(true);
    expect(PASSWORD_HASH_RE.test(stored)).toBe(true);
  });

  it('自描述参数：非默认 N（16384）的历史格式哈希仍可校验', async () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const hash = scryptSync('legacy-secret', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 512 * 1024 * 1024 });
    const stored = `scrypt:16384:8:1:${salt.toString('hex')}:${hash.toString('hex')}`;
    expect(await verifyPassword('legacy-secret', stored)).toBe(true);
    expect(await verifyPassword('other', stored)).toBe(false);
  });

  it('哑哈希：stored 为 null / 乱码 / bcrypt 形状 → 恒 false 且不抛', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', '$2b$12$K7Q1Zf0G5bJnH0m0X3Y4Z.9jZ1wY0aB3cD4eF5gH6iJ7kL8mN9oPa')).toBe(false);
  });

  it('同哈希多次校验结果一致（盐在哈希内，无需额外状态）', async () => {
    const stored = await hashPassword('repeatable');
    for (let i = 0; i < 3; i += 1) {
      expect(await verifyPassword('repeatable', stored)).toBe(true);
    }
  });
});

describe('assertPasswordPolicy', () => {
  const policy = resolvePasswordPolicy({ minLength: 10 });

  it('短密码 → WeakPasswordError（带原因）', () => {
    expect(() => assertPasswordPolicy('short', policy)).toThrow(WeakPasswordError);
    expect(() => assertPasswordPolicy('short', policy)).toThrow(/at least 10/);
  });

  it('超长密码拒绝（防极端输入）', () => {
    expect(() => assertPasswordPolicy('a'.repeat(129), policy)).toThrow(WeakPasswordError);
  });

  it('自定义 validate 钩子：返回原因即拒绝', () => {
    const withHook = resolvePasswordPolicy({ minLength: 6, validate: (pw) => (pw.includes('123') ? 'must not contain sequences' : null) });
    expect(() => assertPasswordPolicy('abc123xyz', withHook)).toThrow(/sequences/);
    expect(() => assertPasswordPolicy('abcdef', withHook)).not.toThrow();
  });

  it('非法策略配置在 resolve 阶段即抛（不带进运行期）', () => {
    expect(() => resolvePasswordPolicy({ minLength: 3 })).toThrow(WeakPasswordError);
    expect(() => resolvePasswordPolicy({ minLength: 10, maxLength: 5 })).toThrow(WeakPasswordError);
  });
});
