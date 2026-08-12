import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RateLimiter } from './rate-limit.js';

// 加载 monorepo 根 .env（vitest 不自动加载）
const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

/**
 * RateLimiter 单测（真实 Redis）。
 * 覆盖 check / checkAll / checkTpm / checkTpmAll 四个方法的分支：
 *   - 滑动窗口计数（未超限通过 + remaining 递减 + 超限拒绝）
 *   - 超限不计数（被拒请求不占窗口配额）
 *   - maxCount ≤ 0 → 无限制
 *   - checkAll 多维度短路（任一超限即拒，dimension 指向首个超限维度）
 *   - checkTpm 已结算 token + 预占 token 越界判定
 *   - checkTpmAll 多维度短路
 *
 * 无 Redis 时 beforeAll 置 connected=false，所有 it 走 skip（不阻塞 CI）。
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis = new Redis(REDIS_URL, { retryStrategy: () => null, lazyConnect: true, maxRetriesPerRequest: null });

let connected = false;
beforeAll(async () => {
  try {
    await redis.connect();
    await redis.ping();
    connected = true;
  } catch {
    connected = false;
  }
});

afterAll(async () => {
  await redis.quit().catch(() => {});
});

/** 唯一 dimension 后缀，避免多 case / 多次运行间 Redis key 串扰 */
function uniqDim(prefix: string): string {
  return `${prefix}:${randomUUID().slice(0, 8)}`;
}

describe('RateLimiter.check（RPM 滑动窗口）', () => {
  it('未超限：连续请求通过，remaining 递减', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const dim = uniqDim('test-rpm-pass');
    try {
      // max=3：前 3 个通过，remaining 依次为 2/1/0
      for (let i = 0; i < 3; i++) {
        const r = await rl.check(dim, 3, `${dim}-${i}`);
        expect(r.allowed).toBe(true);
        expect(r.remaining).toBe(2 - i);
      }
      // 第 4 个超限拒绝
      const r4 = await rl.check(dim, 3, `${dim}-3`);
      expect(r4.allowed).toBe(false);
      expect(r4.dimension).toBe(dim);
      expect(r4.retryAfterSec).toBeGreaterThanOrEqual(1);
    } finally {
      await redis.del(`rl:rpm:${dim}`);
    }
  });

  it('超限不计数：被拒请求不进窗口（ZCARD 不增）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const dim = uniqDim('test-rpm-noadd');
    try {
      // 填满窗口（max=2）
      await rl.check(dim, 2, `${dim}-0`);
      await rl.check(dim, 2, `${dim}-1`);
      expect(await redis.zcard(`rl:rpm:${dim}`)).toBe(2);
      // 连续 3 次被拒 → ZCARD 仍是 2（被拒的不 ZADD）
      for (let i = 0; i < 3; i++) {
        const r = await rl.check(dim, 2, `${dim}-reject-${i}`);
        expect(r.allowed).toBe(false);
      }
      expect(await redis.zcard(`rl:rpm:${dim}`)).toBe(2);
    } finally {
      await redis.del(`rl:rpm:${dim}`);
    }
  });

  it('maxCount ≤ 0 → 无限制（始终放行）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const dim = uniqDim('test-rpm-unlimited');
    const r = await rl.check(dim, 0, `${dim}-0`);
    expect(r.allowed).toBe(true);
    // 不应写 key（短路返回，不触 Redis）
    expect(await redis.exists(`rl:rpm:${dim}`)).toBe(0);
  });
});

describe('RateLimiter.checkAll（多维度 RPM）', () => {
  it('任一维度超限即拒，dimension 指向首个超限维度', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const loose = uniqDim('test-all-loose'); // max 大，永不超
    const tight = uniqDim('test-all-tight'); // max=1，第二个请求即超
    try {
      // 第一个请求：两维度都通过
      const r1 = await rl.checkAll(
        [
          { dimension: loose, max: 100 },
          { dimension: tight, max: 1 },
        ],
        'req-1',
      );
      expect(r1.allowed).toBe(true);

      // 第二个请求：tight 维度超限 → 拒，dimension=tight
      const r2 = await rl.checkAll(
        [
          { dimension: loose, max: 100 },
          { dimension: tight, max: 1 },
        ],
        'req-2',
      );
      expect(r2.allowed).toBe(false);
      expect(r2.dimension).toBe(tight);
    } finally {
      await redis.del(`rl:rpm:${loose}`, `rl:rpm:${tight}`);
    }
  });

  it('通过的维度会计数（即使后续维度拒绝也不回滚）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const a = uniqDim('test-all-rollback-a'); // max=5（会通过并计数）
    const b = uniqDim('test-all-rollback-b'); // max=1（第二请求超）
    try {
      // 第一个请求：a 通过并计数，b 通过并计数
      await rl.checkAll([{ dimension: a, max: 5 }, { dimension: b, max: 1 }], 'r1');
      // 第二个请求：a 再次通过计数（→2），b 超限拒
      await rl.checkAll([{ dimension: a, max: 5 }, { dimension: b, max: 1 }], 'r2');
      // a 已计数 2 次（不回滚）
      expect(await redis.zcard(`rl:rpm:${a}`)).toBe(2);
    } finally {
      await redis.del(`rl:rpm:${a}`, `rl:rpm:${b}`);
    }
  });
});

describe('RateLimiter.checkTpm（TPM 分钟桶）', () => {
  it('已结算 + 预占 ≤ max → 放行；越界 → 拒', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const dim = uniqDim('test-tpm');
    const minute = Math.floor(Date.now() / 60_000);
    try {
      // 预置当前分钟桶已有 500000 token
      await redis.set(`tpm:${dim}:${minute}`, '500000');

      // 预占 400000 → 500000 + 400000 = 900000 ≤ 1000000 → 放行
      const ok = await rl.checkTpm(dim, 400_000, 1_000_000);
      expect(ok.allowed).toBe(true);

      // 预占 600000 → 500000 + 600000 = 1100000 > 1000000 → 拒
      const blocked = await rl.checkTpm(dim, 600_000, 1_000_000);
      expect(blocked.allowed).toBe(false);
      expect(blocked.dimension).toBe(dim);
      expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    } finally {
      await redis.del(`tpm:${dim}:${minute}`);
    }
  });

  it('checkTpm 只读不写（不修改桶值，防并发竞态）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const dim = uniqDim('test-tpm-readonly');
    const minute = Math.floor(Date.now() / 60_000);
    try {
      await redis.set(`tpm:${dim}:${minute}`, '100');
      await rl.checkTpm(dim, 50, 1_000_000); // 放行
      // 桶值仍是 100（checkTpm 不 INCRBY，回填由 worker 负责）
      expect(await redis.get(`tpm:${dim}:${minute}`)).toBe('100');
    } finally {
      await redis.del(`tpm:${dim}:${minute}`);
    }
  });

  it('maxTpm ≤ 0 → 无限制（始终放行）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const dim = uniqDim('test-tpm-unlimited');
    const r = await rl.checkTpm(dim, 999_999_999, 0);
    expect(r.allowed).toBe(true);
  });
});

describe('RateLimiter.checkTpmAll（多维度 TPM）', () => {
  it('任一维度越界即拒，dimension 指向首个超限维度', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = new RateLimiter(redis);
    const loose = uniqDim('test-tpm-all-loose');
    const tight = uniqDim('test-tpm-all-tight');
    const minute = Math.floor(Date.now() / 60_000);
    try {
      // tight 桶预置接近上限
      await redis.set(`tpm:${tight}:${minute}`, '950000');
      // loose 空（0）+ 预占 100000 → 100000 ≤ 1000000 放行
      // tight 950000 + 100000 = 1050000 > 1000000 → 拒，dimension=tight
      const r = await rl.checkTpmAll(
        [
          { dimension: loose, estimatedTokens: 100_000, max: 1_000_000 },
          { dimension: tight, estimatedTokens: 100_000, max: 1_000_000 },
        ],
      );
      expect(r.allowed).toBe(false);
      expect(r.dimension).toBe(tight);
    } finally {
      await redis.del(`tpm:${loose}:${minute}`, `tpm:${tight}:${minute}`);
    }
  });
});
