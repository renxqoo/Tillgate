import type { Redis } from 'ioredis';

/**
 * 限流器（requirements 4.6）：
 *   维度：全局 / 用户 / Key / App / 模型 / 渠道
 *   单位：RPM（请求数/分钟）+ TPM（token/分钟，实际 token 由 worker 结算时回填）
 *
 * 实现：Redis ZSET 滑动窗口（score=timestamp ms，member=requestId）。
 *   Lua 原子：清理过期 → 计数 → 超限返回 Retry-After → 否则 ZADD。
 *   精度优于固定窗口（无边界突刺）；O(log N) 但 N=窗口内请求数，实际很小。
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

export class RateLimiter {
  private sha: string | null = null;
  private allSha: string | null = null;
  private reserveTpmSha: string | null = null;
  private releaseTpmSha: string | null = null;

  constructor(private readonly redis: Redis) {}

  /**
   * 检查并计数（原子）。超限不计数（请求被拒绝，不占窗口配额）。
   * @param dimension 维度标识（如 'user:1' / 'key:5' / 'global'）
   * @param maxCount 窗口内最大请求数
   * @param requestId 唯一请求 ID（ZSET member，防重复计数）
   */
  async check(dimension: string, maxCount: number, requestId: string): Promise<RateLimitResult> {
    if (maxCount <= 0) {
      return { allowed: true }; // 无限制（limit 未配置）
    }
    const sha = await this.ensureSha();
    // 固定 hash tag，保证多维 Lua 在 Redis Cluster 中落在同一 slot。
    const key = `rl:{rpm}:${dimension}`;
    const now = Date.now();
    const res = (await this.redis.evalsha(
      sha,
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

  /**
   * 多维度原子检查：任一维度超限时一项都不计数。
   */
  async checkAll(
    dims: Array<{ dimension: string; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult> {
    const limited = dims.filter((item) => item.max > 0);
    if (limited.length === 0) return { allowed: true };
    const sha = await this.ensureAllSha();
    const result = (await this.redis.evalsha(
      sha,
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

  /**
   * 多维 TPM 原子预占。所有维度先检查再统一写入；任一超限则一项都不写。
   * 预占由结算后的 backfillTpm 提交为 actual；无上游执行的失败必须调用 releaseTpm。
   */
  async reserveTpmAll(
    dims: Array<{ dimension: string; estimatedTokens: number; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult> {
    const limited = dims.filter((item) => item.max > 0);
    if (limited.length === 0) return { allowed: true };
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
    const sha = await this.ensureReserveTpmSha();
    const result = (await this.redis.evalsha(
      sha,
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

  async releaseTpm(requestId: string): Promise<void> {
    const sha = await this.ensureReleaseTpmSha();
    await this.redis.evalsha(sha, 1, `{tpm}:request:${requestId}`);
  }

  /** 长流续租 TPM 预占，避免流仍在传输时 reservation TTL 提前释放。 */
  async renewTpm(requestId: string): Promise<void> {
    const key = `{tpm}:request:${requestId}`;
    const reservedKeys = await this.redis.hkeys(key);
    if (reservedKeys.length === 0) return;
    const tx = this.redis.multi();
    tx.expire(key, 600);
    for (const reservedKey of reservedKeys) tx.expire(reservedKey, 600);
    await tx.exec();
  }

  private async ensureSha(): Promise<string> {
    if (this.sha) return this.sha;
    this.sha = (await this.redis.script('LOAD', CHECK_SCRIPT)) as unknown as string;
    return this.sha;
  }

  private async ensureAllSha(): Promise<string> {
    if (!this.allSha) {
      this.allSha = (await this.redis.script('LOAD', CHECK_ALL_SCRIPT)) as unknown as string;
    }
    return this.allSha;
  }

  private async ensureReserveTpmSha(): Promise<string> {
    if (!this.reserveTpmSha) {
      this.reserveTpmSha = (await this.redis.script(
        'LOAD',
        RESERVE_TPM_SCRIPT,
      )) as unknown as string;
    }
    return this.reserveTpmSha;
  }

  private async ensureReleaseTpmSha(): Promise<string> {
    if (!this.releaseTpmSha) {
      this.releaseTpmSha = (await this.redis.script(
        'LOAD',
        RELEASE_TPM_SCRIPT,
      )) as unknown as string;
    }
    return this.releaseTpmSha;
  }
}
