/**
 * 滑动窗口限流器（真实 Redis；REDIS_URL 未配置整套 skip——同 redis-integration 门禁口径）。
 * 行为规格 = v1 gateway production-hardening/final-hardening 用例的机制段（策略段归 app）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { isInfrastructureError } from '@tokenlens/errors';
import {
  createSlidingWindowLimiter,
  rateLimitUnavailable,
  type SlidingWindowLimiter,
} from '../src/redis/rate-limiter';
import { connectTestRedis, disconnectTestRedis, testRedisUrl } from '../src/testing';

const url = testRedisUrl();

/** 预期不可达实例（错误事件静默——连接失败是测试路径，不泄漏 unhandled 噪声） */
function deadRedis(): Redis {
  const redis = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', () => {});
  return redis;
}

describe.skipIf(url == null)('createSlidingWindowLimiter（真实 Redis）', () => {
  let redis: Redis | null = null;
  let limiter: SlidingWindowLimiter;

  beforeAll(async () => {
    redis = await connectTestRedis();
    limiter = createSlidingWindowLimiter(redis!);
  });
  afterAll(() => disconnectTestRedis(redis));

  it('RPM 单维：阈值内计数、超限拒绝且不计数、Retry-After 递减', async () => {
    const dim = `it-rpm-${Date.now()}`;
    const a = await limiter.check(dim, 2, 'r1');
    expect(a.allowed).toBe(true);
    expect(a.remaining).toBe(1);
    const b = await limiter.check(dim, 2, 'r2');
    expect(b.allowed).toBe(true);
    const c = await limiter.check(dim, 2, 'r3');
    expect(c.allowed).toBe(false);
    expect(c.retryAfterSec).toBeGreaterThanOrEqual(1);
    // 超限不计数：第四次的 remaining 口径不受影响（仍被拒）
    const d = await limiter.check(dim, 2, 'r4');
    expect(d.allowed).toBe(false);
  });

  it('RPM 多维原子：任一维超限则一项都不计（并罚制机制底座）', async () => {
    const dimA = `it-multi-a-${Date.now()}`;
    const dimB = `it-multi-b-${Date.now()}`;
    await limiter.check(dimA, 1, 'seed'); // 占满 A 维
    const res = await limiter.checkAll(
      [
        { dimension: dimA, max: 1 },
        { dimension: dimB, max: 10 },
      ],
      'r5',
    );
    expect(res.allowed).toBe(false);
    expect(res.dimension).toBe(dimA);
    // B 维未被计入（原子性：拒绝时一项都不计）
    const bAfter = await limiter.check(dimB, 1, 'r6');
    expect(bAfter.allowed).toBe(true);
  });

  it('TPM 预占/释放：预占计入窗口、release 归还、幂等释放', async () => {
    const dim = `it-tpm-${Date.now()}`;
    const r1 = await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 60, max: 100 }], 'it-tpm-1');
    expect(r1.allowed).toBe(true);
    const r2 = await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 60, max: 100 }], 'it-tpm-2');
    expect(r2.allowed).toBe(false); // 60+60 > 100
    await limiter.releaseTpm('it-tpm-1');
    await limiter.releaseTpm('it-tpm-1'); // 幂等
    const r3 = await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 60, max: 100 }], 'it-tpm-3');
    expect(r3.allowed).toBe(true); // 释放归还后可再占
  });

  it('TPM 同请求重复预占不叠加（HEXISTS 幂等）', async () => {
    const dim = `it-tpm-idem-${Date.now()}`;
    await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 50, max: 100 }], 'it-idem');
    await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 50, max: 100 }], 'it-idem');
    const res = await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 50, max: 100 }], 'it-idem-other');
    expect(res.allowed).toBe(true); // 同请求二占不叠加：50（非 100）
  });

  it('backfillTpm：释放预占 + 记 actual + 幂等（projected 防重）', async () => {
    // requestId 按轮唯一：projected 防重标记 TTL 86400s，常量 id 会被上一轮的标记
    // 直接幂等跳过（首轮调试即栽在此——测试卫生，非机制缺陷）
    const run = `it-bf-${Date.now()}`;
    const dim = `it-backfill-${run}`;
    await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 80, max: 100 }], run);
    await limiter.backfillTpm(run, [dim], 30);
    await limiter.backfillTpm(run, [dim], 30); // 幂等
    // actual=30 已记、预占已释放：31 计 30+31=61≤100 放行
    const ok = await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 31, max: 100 }], `${run}-2`);
    expect(ok.allowed).toBe(true);
    // 边界维：干净维度上 30(actual)+70(reserved)=100 恰等上限仍放行（严格大于才拒）
    const edgeDim = `${dim}-edge`;
    await limiter.reserveTpmAll([{ dimension: edgeDim, estimatedTokens: 80, max: 100 }], `${run}-e`);
    await limiter.backfillTpm(`${run}-e`, [edgeDim], 30);
    const edge = await limiter.reserveTpmAll([{ dimension: edgeDim, estimatedTokens: 70, max: 100 }], `${run}-3`);
    expect(edge.allowed).toBe(true);
    // 30+31(在途预占)+101 > 100：拒绝且不计数
    const over = await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 101, max: 100 }], `${run}-4`);
    expect(over.allowed).toBe(false);
  });

  it('fail-closed：存储不可用抛 infrastructure 身份码 runtime.rate_limit_unavailable', async () => {
    const dead = deadRedis();
    const closed = createSlidingWindowLimiter(dead);
    const err = await closed.check('x', 5, 'r').then(() => null, (e: Error) => e);
    expect(isInfrastructureError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe('runtime.rate_limit_unavailable');
    dead.disconnect();
  });

  it('fail-open：存储不可用放行（仅失去限流）', async () => {
    const dead = deadRedis();
    const open = createSlidingWindowLimiter(dead, { failMode: 'open' });
    await expect(open.check('x', 5, 'r')).resolves.toMatchObject({ allowed: true });
    dead.disconnect();
  });

  it('rateLimitUnavailable 工厂：英文 message + 身份码', () => {
    const err = rateLimitUnavailable(new Error('boom'));
    expect(err.code).toBe('runtime.rate_limit_unavailable');
    expect(err.message).toContain('boom');
  });
});

/** 最小替身：仅 renewTpm 走的真实命令面（hkeys/multi/expire），Lua 路径不经此 */
function stubRedis(ops: Partial<Record<'hkeys', unknown>>): Redis {
  const multi = {
    expire(_key: string, _seconds: number) {
      return multi;
    },
    async exec() {
      return [];
    },
  };
  return {
    hkeys: (ops.hkeys as () => Promise<string[]>) ?? (async () => []),
    multi: () => multi,
  } as unknown as Redis;
}

describe('限流器机制分支（mock Redis——Lua 外的短路/日志/best-effort 路径）', () => {
  it('maxCount<=0 与空 dims 短路：直接放行不触存储', async () => {
    const limiter = createSlidingWindowLimiter(stubRedis({}));
    await expect(limiter.check('x', 0, 'r')).resolves.toMatchObject({ allowed: true });
    await expect(limiter.check('x', -1, 'r')).resolves.toMatchObject({ allowed: true });
    await expect(limiter.checkAll([], 'r')).resolves.toMatchObject({ allowed: true });
    await expect(limiter.checkAll([{ dimension: 'd', max: 0 }], 'r')).resolves.toMatchObject({
      allowed: true,
    });
    await expect(limiter.reserveTpmAll([{ dimension: 'd', estimatedTokens: 5, max: 0 }], 'r')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('renewTpm：无预交维度早退；有维度则全部续期 600s', async () => {
    const redis = stubRedis({ hkeys: async () => [] });
    await createSlidingWindowLimiter(redis).renewTpm('none'); // 早退
    const withKeys = stubRedis({ hkeys: async () => ['{tpm}:reserved:1:d1', '{tpm}:reserved:1:d2'] });
    await createSlidingWindowLimiter(withKeys).renewTpm('live');
  });

  it('renewTpm / releaseTpm / backfillTpm 存储故障：best-effort 记 warn 不抛', async () => {
    const warns: string[] = [];
    const logger = { warn: (_o: unknown, msg: string) => warns.push(msg) };
    const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    dead.on('error', () => {});
    const limiter = createSlidingWindowLimiter(dead, { logger });
    await expect(limiter.renewTpm('r')).resolves.toBeUndefined();
    await expect(limiter.releaseTpm('r')).resolves.toBeUndefined();
    await expect(limiter.backfillTpm('r', ['d'], 5)).resolves.toBeUndefined();
    expect(warns.length).toBe(3); // 三条 best-effort 告警均落日志
    dead.disconnect();
  });

  it('backfillTpm：dimensions 空数组早退（tokens=0 也需维非空才走脚本）', async () => {
    const limiter = createSlidingWindowLimiter(stubRedis({}));
    await expect(limiter.backfillTpm('r', [], 0)).resolves.toBeUndefined();
  });

  it('fail-closed 落 warn 日志（failClosed 与 fail-open 两分支的告警文案）', async () => {
    const warns: string[] = [];
    const logger = { warn: (_o: unknown, msg: string) => warns.push(msg) };
    const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    dead.on('error', () => {});
    await createSlidingWindowLimiter(dead, { logger })
      .check('x', 5, 'r')
      .catch(() => {});
    await createSlidingWindowLimiter(dead, { failMode: 'open', logger }).check('x', 5, 'r');
    expect(warns.some((m) => m.includes('failing closed'))).toBe(true);
    expect(warns.some((m) => m.includes('failing open'))).toBe(true);
    dead.disconnect();
  });
});
