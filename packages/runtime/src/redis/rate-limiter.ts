/**
 * 滑动窗口限流器（v1 ai-getway packages/core/src/redis/rate-limiter.ts 平移；
 * gateway P5 波裁决 C-G5——机制归 runtime，策略归 app）：
 *   维度自由组合（key:N / channel:N / user:N…）；RPM = ZSET 滑动窗口
 *   （score=timestamp ms，member=requestId，精度优于固定窗口无边界突刺）；
 *   TPM = actual+reserved 双计数预占（结算时 worker 回填 actual，失败释放 reserved）。
 *
 * 故障语义（Redis 是首选组件）：默认 fail-closed——存储不可用时抛
 * InfrastructureError('runtime.rate_limit_unavailable')，调用方拒绝请求（503）；
 * 显式 failMode:'open' 才放行（仅失去限流，资金正确性仍由 billing_requests DB 硬闸门兜底）。
 * releaseTpm/renewTpm/backfillTpm 恒 best-effort（释放/续租失败不该反杀在途请求，TTL 兜底）。
 */
import { InfrastructureError } from '@tillgate/errors';
import type { Redis } from 'ioredis';
import { createRedisScriptRunner } from './script-runner.js';

/** fail-closed 语义的限流存储错误（face 渲染 infrastructure → 503 + 身份码） */
export function rateLimitUnavailable(cause: unknown): InfrastructureError {
  return new InfrastructureError(
    `rate limit storage unavailable: ${(cause as Error)?.message ?? String(cause)}`,
    'runtime.rate_limit_unavailable',
  );
}

const WINDOW_MS = 60_000;

// KEYS[1]=zset key；ARGV=[nowMs, windowMs, max, member]；返回 {1, remaining} 或 {0, retryAfterMs}
const CHECK_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local maxCount = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= maxCount then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldestScore = tonumber(oldest[2]) or now
  return {0, oldestScore + window - now}
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], window + 1000)
return {1, maxCount - count - 1}
`;

// 多维 RPM 原子检查：任一超限则一项都不计。返回 {1,0} 或 {0, 命中维下标}
const CHECK_ALL_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
for i = 1, #KEYS do
  local maximum = tonumber(ARGV[3 + i])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], 0, now - window)
  if redis.call('ZCARD', KEYS[i]) >= maximum then return {0, i} end
end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], window + 1000)
end
return {1, 0}
`;

// 结算回填：释放预占 + 记账 actual（幂等）。KEYS[1]=reservation hash，KEYS[2]=projected
// 防重标记，KEYS[3..]=actual 计数键；ARGV[1]=真实 token 数。
const BACKFILL_TPM_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local values = redis.call('HGETALL', KEYS[1])
for i = 1, #values, 2 do
  local reservedKey = values[i]
  local current = tonumber(redis.call('GET', reservedKey) or '0')
  local amount = tonumber(values[i + 1])
  redis.call('SET', reservedKey, tostring(math.max(0, current - amount)), 'EX', 600)
end
redis.call('SET', KEYS[2], '1', 'EX', 86400)
for i = 3, #KEYS do
  redis.call('INCRBY', KEYS[i], tonumber(ARGV[1]))
  redis.call('EXPIRE', KEYS[i], 600)
end
redis.call('DEL', KEYS[1])
return 1
`;

// 多维 TPM 原子预占。KEYS 最后一个是 request reservation hash，前面每维两项：actual/reserved。
const RESERVE_TPM_SCRIPT = `
local count = tonumber(ARGV[1])
for i = 1, count do
  local actual = tonumber(redis.call('GET', KEYS[(i - 1) * 2 + 1]) or '0')
  local reserved = tonumber(redis.call('GET', KEYS[(i - 1) * 2 + 2]) or '0')
  local amount = tonumber(ARGV[1 + (i - 1) * 2 + 1])
  local maximum = tonumber(ARGV[1 + (i - 1) * 2 + 2])
  if actual + reserved + amount > maximum then
    return {0, i}
  end
end
local reservationKey = KEYS[count * 2 + 1]
for i = 1, count do
  local reservedKey = KEYS[(i - 1) * 2 + 2]
  local amount = tonumber(ARGV[1 + (i - 1) * 2 + 1])
  if redis.call('HEXISTS', reservationKey, reservedKey) == 0 then
    redis.call('INCRBY', reservedKey, amount)
    redis.call('EXPIRE', reservedKey, 600)
    redis.call('HSET', reservationKey, reservedKey, amount)
  end
end
redis.call('EXPIRE', reservationKey, 600)
return {1, 0}
`;

const RELEASE_TPM_SCRIPT = `
local values = redis.call('HGETALL', KEYS[1])
for i = 1, #values, 2 do
  local current = tonumber(redis.call('GET', values[i]) or '0')
  local amount = tonumber(values[i + 1])
  redis.call('SET', values[i], math.max(0, current - amount), 'EX', 600)
end
redis.call('DEL', KEYS[1])
return #values / 2
`;

export interface RateLimitResult {
  allowed: boolean;
  /** 剩余配额（allowed=true 时） */
  remaining?: number;
  /** 超限后建议等待秒数（allowed=false 时，用于 Retry-After 头） */
  retryAfterSec?: number;
  /** 哪个维度拒绝了（排障用） */
  dimension?: string;
}

export interface SlidingWindowLimiter {
  /** 检查并计数（原子）；超限不计数。maxCount<=0 视为无限制。 */
  check(dimension: string, maxCount: number, requestId: string): Promise<RateLimitResult>;
  /** 多维度原子检查：任一维度超限时一项都不计数。 */
  checkAll(
    dims: Array<{ dimension: string; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult>;
  /** 多维 TPM 原子预占。无上游执行的失败必须 releaseTpm。 */
  reserveTpmAll(
    dims: Array<{ dimension: string; estimatedTokens: number; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult>;
  releaseTpm(requestId: string): Promise<void>;
  /** 长流续租 TPM 预占，避免流仍在传输时 reservation TTL 提前释放。 */
  renewTpm(requestId: string): Promise<void>;
  /**
   * 结算回填（成功请求的 TPM 收尾——契约写明「结算时 worker 回填 actual」）：
   * 释放该请求 reservation hash 里的全部预占维度 + 把真实 token 记到收据归属
   * 维度的 actual 计数。幂等（projected 标记防重放）；best-effort 不抛错。
   * 缺席时成功请求的预占只能等 TTL 600s 自然过期——TPM 窗口被残留预占越占越紧。
   */
  backfillTpm(requestId: string, dimensions: readonly string[], tokens: number): Promise<void>;
}

export interface SlidingWindowLimiterOptions {
  logger?: { warn(obj: unknown, msg: string): void };
  /** Redis 故障语义：closed（默认）= 抛错拒绝；open = 放行（仅失去限流） */
  failMode?: 'open' | 'closed';
}

// eslint-disable-next-line max-lines-per-function -- 资金域限流器工厂（v1 平移存量）：4 个单用途 inner helper + 6 方法装配面单体内聚；拆出模块级需为 4-5 参 helper 全部铺设参数对象（受 max-params=3 约束），透传噪音大于结构收益（铁律 22⑥ 存量棘轮）
export function createSlidingWindowLimiter(
  redis: Redis,
  options: SlidingWindowLimiterOptions = {},
): SlidingWindowLimiter {
  const { logger } = options;
  const failClosed = (options.failMode ?? 'closed') === 'closed';
  const scripts = createRedisScriptRunner(redis);

  async function guard(
    op: () => Promise<RateLimitResult>,
    fallback: RateLimitResult,
  ): Promise<RateLimitResult> {
    try {
      return await op();
    } catch (error) {
      if (failClosed) {
        logger?.warn(
          { err: (error as Error).message },
          'rate limit storage unavailable, failing closed',
        );
        throw rateLimitUnavailable(error);
      }
      logger?.warn(
        { err: (error as Error).message },
        'rate limit storage unavailable, failing open (DB hard gate remains)',
      );
      return fallback;
    }
  }

  async function checkInner(
    dimension: string,
    maxCount: number,
    requestId: string,
  ): Promise<RateLimitResult> {
    // 固定 hash tag，保证多维 Lua 在 Redis Cluster 中落在同一 slot
    const key = `rl:{rpm}:${dimension}`;
    const res = (await scripts.run(
      CHECK_SCRIPT,
      1,
      key,
      Date.now(),
      WINDOW_MS,
      maxCount,
      requestId,
    )) as number[];
    if (res[0] === 1) return { allowed: true, remaining: res[1], dimension };
    const retryAfterSec = Math.max(1, Math.ceil((res[1] ?? WINDOW_MS) / 1000));
    return { allowed: false, retryAfterSec, dimension };
  }

  async function checkAllInner(
    limited: Array<{ dimension: string; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult> {
    const result = (await scripts.run(
      CHECK_ALL_SCRIPT,
      limited.length,
      ...limited.map((item) => `rl:{rpm}:${item.dimension}`),
      Date.now(),
      WINDOW_MS,
      requestId,
      ...limited.map((item) => item.max),
    )) as number[];
    if (result[0] === 1) return { allowed: true };
    const blocked = limited[Math.max(0, Number(result[1]) - 1)];
    return { allowed: false, retryAfterSec: 60, dimension: blocked?.dimension };
  }

  async function reserveTpmAllInner(
    limited: Array<{ dimension: string; estimatedTokens: number; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult> {
    const minute = Math.floor(Date.now() / 60_000);
    const tag = `{tpm}`;
    const keys = limited.flatMap((item) => [
      `${tag}:actual:${minute}:${item.dimension}`,
      `${tag}:reserved:${minute}:${item.dimension}`,
    ]);
    const reservationKey = `${tag}:request:${requestId}`;
    const args = limited.flatMap((item) => [
      Math.max(0, Math.ceil(item.estimatedTokens)),
      item.max,
    ]);
    const result = (await scripts.run(
      RESERVE_TPM_SCRIPT,
      keys.length + 1,
      ...keys,
      reservationKey,
      limited.length,
      ...args,
    )) as number[];
    if (result[0] === 1) return { allowed: true };
    const blocked = limited[Math.max(0, Number(result[1]) - 1)];
    return {
      allowed: false,
      retryAfterSec: Math.max(1, 60 - Math.floor((Date.now() % 60_000) / 1000)),
      dimension: blocked?.dimension,
    };
  }

  return {
    async check(dimension, maxCount, requestId) {
      if (maxCount <= 0) return { allowed: true, dimension };
      return guard(() => checkInner(dimension, maxCount, requestId), { allowed: true, dimension });
    },
    async checkAll(dims, requestId) {
      const limited = dims.filter((item) => item.max > 0);
      if (limited.length === 0) return { allowed: true };
      return guard(() => checkAllInner(limited, requestId), { allowed: true });
    },
    async reserveTpmAll(dims, requestId) {
      const limited = dims.filter((item) => item.max > 0);
      if (limited.length === 0) return { allowed: true };
      return guard(() => reserveTpmAllInner(limited, requestId), { allowed: true });
    },
    async releaseTpm(requestId) {
      await scripts
        .run(RELEASE_TPM_SCRIPT, 1, `{tpm}:request:${requestId}`)
        .catch((error: Error) => {
          logger?.warn(
            { requestId, err: error.message },
            'releaseTpm storage unavailable (best-effort; TTL reclaims)',
          );
        });
    },
    async backfillTpm(requestId, dimensions, tokens) {
      // dimensions 空才可跳过：tokens=0 也必须走脚本（释放预占——零额结算的请求
      // 预占若不释放会占满 TPM 窗口直到 TTL）
      if (dimensions.length === 0) return;
      const minute = Math.floor(Date.now() / 60_000);
      const actualKeys = dimensions.map((dimension) => `{tpm}:actual:${minute}:${dimension}`);
      await scripts
        .run(
          BACKFILL_TPM_SCRIPT,
          actualKeys.length + 2,
          `{tpm}:request:${requestId}`,
          `{tpm}:projected:${requestId}`,
          ...actualKeys,
          tokens,
        )
        .catch((error: Error) => {
          logger?.warn(
            { requestId, err: error.message },
            'backfillTpm storage unavailable (best-effort; TTL reclaims)',
          );
        });
    },
    async renewTpm(requestId) {
      try {
        const key = `{tpm}:request:${requestId}`;
        const reservedKeys = await redis.hkeys(key);
        if (reservedKeys.length === 0) return;
        const tx = redis.multi();
        tx.expire(key, 600);
        for (const reservedKey of reservedKeys) tx.expire(reservedKey, 600);
        await tx.exec();
      } catch (error) {
        logger?.warn(
          { requestId, err: (error as Error).message },
          'renewTpm storage unavailable (best-effort; TTL reclaims)',
        );
      }
    },
  };
}
