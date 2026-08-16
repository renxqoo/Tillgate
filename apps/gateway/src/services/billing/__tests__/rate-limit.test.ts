import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createEphemeralRedis, type EphemeralRedis } from '@ai-gateway/http';
import { createRateLimiter } from '../rate-limit-service.js';

// 加载 monorepo 根 .env（vitest 不自动加载）
const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
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
 * 覆盖 RPM 与 TPM 的原子多维预占：
 *   - 滑动窗口计数（未超限通过 + remaining 递减 + 超限拒绝）
 *   - 超限不计数（被拒请求不占窗口配额）
 *   - maxCount ≤ 0 → 无限制
 *   - checkAll 多维度短路（任一超限即拒，dimension 指向首个超限维度）
 *   - TPM 并发预占不能穿透
 *
 * 无 Redis 时 beforeAll 置 connected=false，所有 it 走 skip（不阻塞 CI）。
 */
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await redis.ping();
    connected = true;
  } catch {
    connected = false;
  }
});

afterAll(async () => {
  await redis?.close();
});

/** 唯一 dimension 后缀，避免多 case / 多次运行间 Redis key 串扰 */
function uniqDim(prefix: string): string {
  return `${prefix}:${randomUUID().slice(0, 8)}`;
}

describe('RateLimiter.check（RPM 滑动窗口）', () => {
  it('未超限：连续请求通过，remaining 递减', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = createRateLimiter(redis);
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
      await redis.del(`rl:{rpm}:${dim}`);
    }
  });

  it('超限不计数：被拒请求不进窗口（ZCARD 不增）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = createRateLimiter(redis);
    const dim = uniqDim('test-rpm-noadd');
    try {
      // 填满窗口（max=2）
      await rl.check(dim, 2, `${dim}-0`);
      await rl.check(dim, 2, `${dim}-1`);
      expect(await redis.zcard(`rl:{rpm}:${dim}`)).toBe(2);
      // 连续 3 次被拒 → ZCARD 仍是 2（被拒的不 ZADD）
      for (let i = 0; i < 3; i++) {
        const r = await rl.check(dim, 2, `${dim}-reject-${i}`);
        expect(r.allowed).toBe(false);
      }
      expect(await redis.zcard(`rl:{rpm}:${dim}`)).toBe(2);
    } finally {
      await redis.del(`rl:{rpm}:${dim}`);
    }
  });

  it('maxCount ≤ 0 → 无限制（始终放行）', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = createRateLimiter(redis);
    const dim = uniqDim('test-rpm-unlimited');
    const r = await rl.check(dim, 0, `${dim}-0`);
    expect(r.allowed).toBe(true);
    // 不应写 key（短路返回，不触 Redis）
    expect(await redis.exists(`rl:{rpm}:${dim}`)).toBe(0);
  });
});

describe('RateLimiter.checkAll（多维度 RPM）', () => {
  it('任一维度超限即拒，dimension 指向首个超限维度', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = createRateLimiter(redis);
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
      await redis.del(`rl:{rpm}:${loose}`, `rl:{rpm}:${tight}`);
    }
  });

  it('后续维度拒绝时所有维度都不计数', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = createRateLimiter(redis);
    const a = uniqDim('test-all-rollback-a'); // max=5（会通过并计数）
    const b = uniqDim('test-all-rollback-b'); // max=1（第二请求超）
    try {
      // 第一个请求：a 通过并计数，b 通过并计数
      await rl.checkAll(
        [
          { dimension: a, max: 5 },
          { dimension: b, max: 1 },
        ],
        'r1',
      );
      // 第二个请求：a 再次通过计数（→2），b 超限拒
      await rl.checkAll(
        [
          { dimension: a, max: 5 },
          { dimension: b, max: 1 },
        ],
        'r2',
      );
      expect(await redis.zcard(`rl:{rpm}:${a}`)).toBe(1);
    } finally {
      await redis.del(`rl:{rpm}:${a}`, `rl:{rpm}:${b}`);
    }
  });
});

describe('RateLimiter.reserveTpmAll（原子并发预占）', () => {
  it('并发请求只能放行额度能覆盖的数量，并可整单释放', async () => {
    if (!connected) return it.skip('no Redis');
    const rl = createRateLimiter(redis);
    const dim = uniqDim('test-tpm-reserve');
    const minute = Math.floor(Date.now() / 60_000);
    const reservedKey = `{tpm}:reserved:${minute}:${dim}`;
    const ids = Array.from({ length: 20 }, () => randomUUID());
    try {
      const results = await Promise.all(
        ids.map((id) =>
          rl.reserveTpmAll([{ dimension: dim, estimatedTokens: 100, max: 1_000 }], id),
        ),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(10);
      expect(await redis.get(reservedKey)).toBe('1000');
      const allowedIds = ids.filter((_, index) => results[index]!.allowed);
      await Promise.all(allowedIds.map((id) => rl.releaseTpm(id)));
      expect(await redis.get(reservedKey)).toBe('0');
    } finally {
      await redis.del(reservedKey, ...ids.map((id) => `{tpm}:request:${id}`));
    }
  });
});
