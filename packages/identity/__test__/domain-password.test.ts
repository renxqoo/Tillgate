/**
 * 密码域测试(v1 identity-core password.test + identity/password.test 合并迁移):
 * scrypt 往返、存储格式快照、自描述参数、哑哈希恒定时间、脏 stored 恒 false、
 * 策略矩阵、超长输入不崩(安全用例随迁)。
 */
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_HASH_RE,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  assertPasswordPolicy,
  hashPassword,
  resolvePasswordPolicy,
  verifyPassword,
} from '../src/domain/password.js';

const POLICY = { minLength: 10, maxLength: 128 };

describe('hashPassword / verifyPassword 往返', () => {
  it('哈希格式快照:scrypt:32768:8:1:<salt32hex>:<hash64hex>', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(PASSWORD_HASH_RE);
    expect(hash.startsWith(`scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:`)).toBe(true);
  });

  it('同密码两次哈希带盐唯一', async () => {
    const a = await hashPassword('same-password-1');
    const b = await hashPassword('same-password-1');
    expect(a).not.toBe(b);
  });

  it('正确密码通过,错误密码拒绝,大小写敏感', async () => {
    const hash = await hashPassword('Abcdefghijk1');
    expect(await verifyPassword('Abcdefghijk1', hash)).toBe(true);
    expect(await verifyPassword('Abcdefghijk2', hash)).toBe(false);
    expect(await verifyPassword('abcdefghijk1', hash)).toBe(false);
  });

  it('自描述参数:历史 N=16384 哈希按行内参数可验(v1 兼容口径)', async () => {
    // 用 v1 自述参数形态构造历史哈希(N=16384),keylen 跟随存储长度
    const { randomBytes, scrypt } = await import('node:crypto');
    const salt = randomBytes(16);
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt('legacy-password-1', salt, 32, { N: 16384, r: 8, p: 1 }, (err, derived) =>
        err ? reject(err) : resolve(derived as Buffer),
      ),
    );
    const legacy = `scrypt:16384:8:1:${salt.toString('hex')}:${key.toString('hex')}`;
    expect(await verifyPassword('legacy-password-1', legacy)).toBe(true);
    expect(await verifyPassword('legacy-password-2', legacy)).toBe(false);
  });

  it('哑哈希恒定时间:不存在/脏 stored 也跑等量 scrypt 且恒 false 不抛', async () => {
    const t0 = Date.now();
    expect(await verifyPassword('whatever-1234', null)).toBe(false);
    const dummyMs = Date.now() - t0;
    const hash = await hashPassword('whatever-1234');
    const t1 = Date.now();
    expect(await verifyPassword('whatever-1234', hash)).toBe(true);
    const realMs = Date.now() - t1;
    // 不存在账号的耗时 ≥ 真实校验的一半(防时序枚举的等量计算口径)
    expect(dummyMs).toBeGreaterThanOrEqual(realMs / 2);
    for (const stored of ['', 'not-a-hash', 'bcrypt$2b$12$...', 'scrypt:1:2:3:zz:ff']) {
      expect(await verifyPassword('whatever-1234', stored)).toBe(false);
    }
  });

  it('10 万字符密码恒定路径拒绝不崩(v1 security 用例随迁)', () => {
    for (const password of ['x'.repeat(100_000), 'y'.repeat(1_000_000)]) {
      const error = catchBusiness(() => assertPasswordPolicy(password, POLICY));
      expect(error.code).toBe('identity.weak_password');
      expect(error.context).toMatchObject({ reason: expect.stringContaining('at most 128') });
    }
  });
});

/** 捕获目录业务错误(断言码与 context;message 是目录固定文案,动态事实在 context) */
function catchBusiness(fn: () => void): { code: string; context: Record<string, unknown> } {
  try {
    fn();
  } catch (error) {
    const business = error as { code?: string; context?: Record<string, unknown> };
    if (typeof business.code === 'string' && business.code.startsWith('identity.')) {
      return { code: business.code, context: business.context ?? {} };
    }
    throw error;
  }
  throw new Error('expected identity business error, nothing thrown');
}

describe('密码策略矩阵', () => {
  it('短密码拒绝并带原因(动态事实在 context.reason)', () => {
    const error = catchBusiness(() => assertPasswordPolicy('short123', POLICY));
    expect(error.code).toBe('identity.weak_password');
    expect(error.context.reason).toMatch('at least 10');
  });

  it('自定义 validate 钩子:返回原因即拒绝', () => {
    const policy = {
      ...POLICY,
      validate: (p: string) => (p.includes(' ') ? 'must not contain spaces' : null),
    };
    expect(
      catchBusiness(() => assertPasswordPolicy('has space inside', policy)).context.reason,
    ).toMatch(/spaces/);
    expect(() => assertPasswordPolicy('no-space-here', POLICY)).not.toThrow();
  });

  it('非法策略配置 resolve 即抛(fail fast)', () => {
    for (const policy of [
      { minLength: 5, maxLength: 128 },
      { minLength: 10, maxLength: 9 },
      { minLength: 10, maxLength: 2000 },
    ]) {
      expect(catchBusiness(() => resolvePasswordPolicy(policy)).code).toBe(
        'identity.invalid_input',
      );
    }
    expect(resolvePasswordPolicy({ minLength: 10, maxLength: 128 })).toEqual(POLICY);
  });
});
