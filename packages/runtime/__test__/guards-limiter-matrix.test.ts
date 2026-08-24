/**
 * 爆破防护与滑动窗口限流器的「快乐路径 + 结果分支」矩阵——CI 无真实 Redis 时
 * 既有真实 Redis 段整体 skip，Lua 结果解析/首计过期/自愈/故障档分支只在本文件覆盖。
 *
 * 两形态替身：
 *   - 语义态：ttl/get/incr/expire/set/del 真语义（auth-guards 行为可断言）；
 *   - 队列态：evalsha 返回 canned 结果队列（限流器 JS 分支：allowed/blocked/下标映射），
 *     空队列抛错 = 存储故障（驱动 fail 档）；noscriptOnce 覆盖 evalsha→LOAD→重试自愈。
 */
import { describe, expect, it } from 'vitest';
import { isInfrastructureError } from '@tillgate/errors';
import { createKeyBruteForceGuard, createAuthFailureGuard } from '../src/redis/auth-guards';
import { createSlidingWindowLimiter } from '../src/redis/rate-limiter';

class FakeRedis {
  store = new Map<string, string>();
  expirations = new Map<string, number>();
  evalResults: unknown[][] = [];
  evalCalls: Array<{ sha: string; numKeys: number; args: unknown[] }> = [];
  noscriptOnce = false;
  failDelOnce = false;
  failExecOnce = false;

  private expired(key: string): boolean {
    const exp = this.expirations.get(key);
    return exp != null && exp <= Date.now();
  }

  async ttl(key: string): Promise<number> {
    if (!this.store.has(key) || this.expired(key)) return -2;
    const remain = Math.ceil(((this.expirations.get(key) ?? Infinity) - Date.now()) / 1000);
    return Number.isFinite(remain) && remain > 0 ? remain : -1;
  }

  async get(key: string): Promise<string | null> {
    if (!this.store.has(key) || this.expired(key)) return null;
    return this.store.get(key) ?? null;
  }

  async incr(key: string): Promise<number> {
    const n = Number((await this.get(key)) ?? 0) + 1;
    this.store.set(key, String(n));
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.store.has(key)) return 0;
    this.expirations.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    if (rest[0] === 'EX') this.expirations.set(key, Date.now() + Number(rest[1]) * 1000);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (this.failDelOnce) {
      this.failDelOnce = false;
      throw new Error('fake del down');
    }
    let n = 0;
    for (const key of keys) {
      if (this.store.delete(key)) n += 1;
      this.expirations.delete(key);
    }
    return n;
  }

  async hkeys(_key: string): Promise<string[]> {
    return this.hkeysResult ?? [];
  }

  hkeysResult: string[] | null = null;

  multi() {
    const ops: Array<[string, unknown[]]> = [];
    const tx = {
      expire: (...args: unknown[]) => {
        ops.push(['expire', args]);
        return tx;
      },
      exec: async () => {
        if (this.failExecOnce) {
          this.failExecOnce = false;
          throw new Error('fake multi down');
        }
        return ops.map(() => ['OK', null]);
      },
    };
    return tx;
  }

  async script(_op: string, body: string): Promise<string> {
    return `sha-${body.length}`;
  }

  async evalsha(sha: string, numKeys: number, ...args: unknown[]): Promise<unknown> {
    this.evalCalls.push({ sha, numKeys, args });
    if (this.noscriptOnce) {
      this.noscriptOnce = false;
      throw new Error('NOSCRIPT No matching script (fake)');
    }
    const next = this.evalResults.shift();
    if (next == null) throw new Error('fake redis storage down');
    return next;
  }
}

describe('爆破防护快乐路径（语义态内存 Redis）', () => {
  it('keyGuard：首计落过期、达阈值上锁、isLocked 两条锁定路径、成功清零', async () => {
    const redis = new FakeRedis();
    const guard = createKeyBruteForceGuard(redis as never, {
      failureThreshold: 3,
      failureWindowS: 60,
      lockS: 30,
    });
    expect(await guard.isLocked('k1')).toEqual({ locked: false, retryAfterSec: 0 });
    expect((await guard.recordFailure('k1')).locked).toBe(false); // n=1 → expire 分支
    expect(redis.expirations.has('auth:fails:k1')).toBe(true);
    expect((await guard.recordFailure('k1')).locked).toBe(false);
    expect((await guard.recordFailure('k1')).locked).toBe(true); // n=3 → 上锁
    const locked = await guard.isLocked('k1'); // ttl>0 路径
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSec).toBeGreaterThan(0);
    await guard.recordSuccess('k1');
    expect((await guard.isLocked('k1')).locked).toBe(false);
  });

  it('keyGuard：计数达阈值但无锁键 → isLocked 按 lockS 判锁', async () => {
    const redis = new FakeRedis();
    const guard = createKeyBruteForceGuard(redis as never, {
      failureThreshold: 2,
      failureWindowS: 60,
      lockS: 45,
    });
    await redis.set('auth:fails:k2', '2'); // 无锁键,计数已达标
    expect(await guard.isLocked('k2')).toEqual({ locked: true, retryAfterSec: 45 });
  });

  it('keyGuard：recordSuccess 清理失败 best-effort 不抛（degraded 同步清本地）', async () => {
    const redis = new FakeRedis();
    const guard = createKeyBruteForceGuard(redis as never, {
      failureThreshold: 2,
      failureWindowS: 60,
      lockS: 30,
    });
    await guard.recordFailure('k3');
    redis.failDelOnce = true;
    await expect(guard.recordSuccess('k3')).resolves.toBeUndefined();
  });

  it('ipGuard：达 limit 上锁（锁长=窗口）、成功清零、清理失败不抛', async () => {
    const redis = new FakeRedis();
    const guard = createAuthFailureGuard(redis as never, { limit: 2, windowS: 60 });
    expect((await guard.recordFailure('1.2.3.4')).locked).toBe(false);
    expect((await guard.recordFailure('1.2.3.4')).locked).toBe(true);
    const locked = await guard.isLocked('1.2.3.4');
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSec).toBeGreaterThan(0);
    await guard.recordSuccess?.('1.2.3.4');
    expect((await guard.isLocked('1.2.3.4')).locked).toBe(false);
    redis.failDelOnce = true;
    await expect(guard.recordSuccess?.('1.2.3.4')).resolves.toBeUndefined();
  });
});

describe('限流器结果分支（队列态 canned evalsha）', () => {
  it('check：allowed 带 remaining;blocked 按 retryAfterMs 换算秒;失败档默认 fail-closed', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    redis.evalResults.push([1, 5]);
    expect(await limiter.check('d', 10, 'r1')).toEqual({
      allowed: true,
      remaining: 5,
      dimension: 'd',
    });
    redis.evalResults.push([0, 12345]);
    expect(await limiter.check('d', 10, 'r2')).toEqual({
      allowed: false,
      retryAfterSec: 13,
      dimension: 'd',
    });
    // 空队列 = 存储故障 → 默认 closed 抛 runtime.rate_limit_unavailable
    await expect(limiter.check('d', 10, 'r3')).rejects.toMatchObject({
      code: 'runtime.rate_limit_unavailable',
    });
  });

  it('check：maxCount<=0 短路放行,不触存储', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    expect(await limiter.check('d', 0, 'r')).toEqual({ allowed: true, dimension: 'd' });
    expect(redis.evalCalls).toHaveLength(0);
  });

  it('checkAll：allowed;blocked 按下标映射维度;open 档存储故障放行', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never, { failMode: 'open' });
    redis.evalResults.push([1, 0]);
    expect(
      await limiter.checkAll(
        [
          { dimension: 'a', max: 1 },
          { dimension: 'b', max: 2 },
        ],
        'r1',
      ),
    ).toEqual({
      allowed: true,
    });
    redis.evalResults.push([0, 2]); // 第 2 维超限
    const blocked = await limiter.checkAll(
      [
        { dimension: 'a', max: 1 },
        { dimension: 'b', max: 2 },
      ],
      'r2',
    );
    expect(blocked).toEqual({ allowed: false, retryAfterSec: 60, dimension: 'b' });
    expect(await limiter.checkAll([{ dimension: 'a', max: 1 }], 'r3')).toEqual({ allowed: true }); // 故障→open 放行
  });

  it('reserveTpmAll：allowed/blocked(retryAfter 有界);空维短路', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    redis.evalResults.push([1]);
    expect(
      (await limiter.reserveTpmAll([{ dimension: 'm', estimatedTokens: 5, max: 100 }], 'r1'))
        .allowed,
    ).toBe(true);
    redis.evalResults.push([0, 1]);
    const blocked = await limiter.reserveTpmAll(
      [{ dimension: 'm', estimatedTokens: 5, max: 100 }],
      'r2',
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.dimension).toBe('m');
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    expect(await limiter.reserveTpmAll([], 'r3')).toEqual({ allowed: true });
  });

  it('releaseTpm/backfillTpm:成功不抛;存储失败 best-effort 吞掉;backfill 空维短路', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    redis.evalResults.push([1]);
    await expect(limiter.releaseTpm('r1')).resolves.toBeUndefined();
    await expect(limiter.releaseTpm('r2')).resolves.toBeUndefined(); // 队列空=故障→吞
    redis.evalResults.push([1]);
    await expect(limiter.backfillTpm('r1', ['m'], 42)).resolves.toBeUndefined();
    expect(redis.evalCalls.at(-1)?.args.at(-1)).toBe(42);
    await expect(limiter.backfillTpm('r2', [], 0)).resolves.toBeUndefined(); // 空维短路
  });

  it('renewTpm:无预占直接返回;有预占续期;exec 失败吞掉', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    await expect(limiter.renewTpm('r1')).resolves.toBeUndefined(); // hkeys 空
    redis.hkeysResult = ['tpm:reserved:1:m'];
    await expect(limiter.renewTpm('r1')).resolves.toBeUndefined();
    redis.hkeysResult = ['tpm:reserved:1:m'];
    redis.failExecOnce = true;
    await expect(limiter.renewTpm('r1')).resolves.toBeUndefined();
  });

  it('NOSCRIPT 自愈：缓存命中抛 NOSCRIPT → 重新 LOAD → 重试成功', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    redis.evalResults.push([1, 0]);
    await limiter.check('d', 5, 'r1'); // 首次：LOAD + evalsha
    const callsAfterFirst = redis.evalCalls.length;
    redis.noscriptOnce = true; // 下一次 cached evalsha 抛 NOSCRIPT
    redis.evalResults.push([1, 0]);
    await limiter.check('d', 5, 'r2'); // 自愈路径：重 LOAD + 重试
    expect(redis.evalCalls.length).toBe(callsAfterFirst + 2);
    redis.evalResults.push([1, 0]);
    expect(await limiter.check('d', 5, 'r3')).toMatchObject({ allowed: true }); // sha 已重缓存
  });

  it('故障档身份码：默认 closed 是 InfrastructureError(runtime.rate_limit_unavailable)', async () => {
    const redis = new FakeRedis();
    const limiter = createSlidingWindowLimiter(redis as never);
    const err = await limiter.check('d', 5, 'r').catch((e: unknown) => e);
    expect(isInfrastructureError(err)).toBe(true);
  });
});
