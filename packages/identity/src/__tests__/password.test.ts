import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../index.js';

async function measure(fn: () => Promise<unknown>): Promise<number> {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function median(xs: number[]): number {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

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

  it('01 修复：用户不存在（null/非法哈希）也执行等量 scrypt，时序不可区分', async () => {
    const real = await hashPassword('some-password');
    // 预热：首次调用懒生成 dummy 哈希（含一次 hashPassword），排除在测量之外
    await verifyPassword('warmup', null);

    const samples = 5;
    const nonexist: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < samples; i++) {
      nonexist.push(await measure(() => verifyPassword('whatever', null)));
      wrong.push(await measure(() => verifyPassword('wrong-password', real)));
    }
    const d = median(nonexist);
    const w = median(wrong);
    // 不存在的账号也必须执行了 scrypt（与「密码错」同量级），而非近 0ms 短路。
    // 断言：dummy 路径耗时 d 与真实校验耗时 w 同量级（d > w*0.5）。
    expect(d).toBeGreaterThan(w * 0.5);
  });

  it('长密码（256 字符）可正常哈希与校验', async () => {
    const long = 'a'.repeat(256);
    const h = await hashPassword(long);
    await expect(verifyPassword(long, h)).resolves.toBe(true);
  });
});
