import type { Redis } from 'ioredis';
import type { Logger } from '@ai-gateway/core';
import { createRedisScriptRunner } from '../../infrastructure/redis-script-runner.js';

/**
 * 限流器（requirements 4.6）：
 *   维度：全局 / 用户 / Key / App / 模型 / 渠道
 *   单位：RPM（请求数/分钟）+ TPM（token/分钟，实际 token 由 worker 结算时回填）
 *
 * 实现：Redis ZSET 滑动窗口（score=timestamp ms，member=requestId）。
 *   Lua 原子：清理过期 → 计数 → 超限返回 Retry-After → 否则 ZADD。
 *   精度优于固定窗口（无边界突刺）；O(log N) 但 N=窗口内请求数，实际很小。
 *   脚本经 RedisScriptRunner 执行：evalsha + NOSCRIPT 自愈（BUG-C，
 *   Redis 重启/SCRIPT FLUSH 后自动重载，不再持续抛错导致全量 500）。
 */

const WINDOW_MS = 60_000; // 1 分钟窗口

// Lua：滑动窗口检查+计数
// KEYS[1]=zset key；ARGV[1]=nowMs, [2]=windowMs, [3]=max, [4]=member(uniqueId)
// 返回 {1, remaining} 通过；{0, retryAfterMs} 拒绝
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

export interface RateLimiter {
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
}

export function createRateLimiter(redis: Redis, logger?: Logger): RateLimiter {
  const scripts = createRedisScriptRunner(redis);

  /**
   * 付费链路限流的存储故障降级（单一真相，与 steps/rate-limit/key-auth-cache 的
   * fail-open 声明一致）：RPM/TPM 是准入闸门而非资金闸门，Redis 故障时放行，
   * 资金正确性由 billing_requests DB 硬闸门兜底。免费模型日计数不在此列
   * （steps/rate-limit 内自行 fail-closed，F7：免费链路唯一防线）。
   */
  async function failOpen(
    op: () => Promise<RateLimitResult>,
    fallback: RateLimitResult,
  ): Promise<RateLimitResult> {
    try {
      return await op();
    } catch (error) {
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
    // 固定 hash tag，保证多维 Lua 在 Redis Cluster 中落在同一 slot。
    const key = `rl:{rpm}:${dimension}`;
    const now = Date.now();
    const res = (await scripts.run(
      CHECK_SCRIPT,
      1,
      key,
      now,
      WINDOW_MS,
      maxCount,
      requestId,
    )) as number[];

    if (res[0] === 1) {
      return { allowed: true, remaining: res[1], dimension };
    }
    // 超限：retryAfterMs → 秒（向上取整，至少 1）
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
      if (maxCount <= 0) {
        return { allowed: true }; // 无限制（limit 未配置）
      }
      return failOpen(() => checkInner(dimension, maxCount, requestId), {
        allowed: true,
        dimension,
      });
    },

    async checkAll(dims, requestId) {
      const limited = dims.filter((item) => item.max > 0);
      if (limited.length === 0) return { allowed: true };
      return failOpen(() => checkAllInner(limited, requestId), { allowed: true });
    },

    async reserveTpmAll(dims, requestId) {
      const limited = dims.filter((item) => item.max > 0);
      if (limited.length === 0) return { allowed: true };
      return failOpen(() => reserveTpmAllInner(limited, requestId), { allowed: true });
    },

    async releaseTpm(requestId) {
      await scripts.run(RELEASE_TPM_SCRIPT, 1, `{tpm}:request:${requestId}`).catch(
        (error: Error) => {
          logger?.warn(
            { requestId, err: error.message },
            'releaseTpm storage unavailable (best-effort; TTL reclaims)',
          );
        },
      );
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
