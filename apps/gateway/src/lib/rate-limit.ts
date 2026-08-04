import type { Redis } from 'ioredis';

/**
 * 限流器（requirements 4.6）：
 *   维度：全局 / 用户 / Key / 模型（四级，从严到松依次检查）
 *   单位：RPM（请求数/分钟）。TPM 需历史计量回填，留 worker 阶段。
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

  constructor(private readonly redis: Redis) {}

  /**
   * 检查并计数（原子）。超限不计数（请求被拒绝，不占窗口配额）。
   * @param dimension 维度标识（如 'user:1' / 'key:5' / 'global'）
   * @param maxCount 窗口内最大请求数
   * @param requestId 唯一请求 ID（ZSET member，防重复计数）
   */
  async check(
    dimension: string,
    maxCount: number,
    requestId: string,
  ): Promise<RateLimitResult> {
    if (maxCount <= 0) {
      return { allowed: true }; // 无限制（limit 未配置）
    }
    const sha = await this.ensureSha();
    const key = `rl:rpm:${dimension}`;
    const now = Date.now();
    const res = (await this.redis.evalsha(sha, 1, key, now, WINDOW_MS, maxCount, requestId)) as number[];

    if (res[0] === 1) {
      return { allowed: true, remaining: res[1], dimension };
    }
    // 超限：retryAfterMs → 秒（向上取整，至少 1）
    const retryAfterSec = Math.max(1, Math.ceil((res[1] ?? WINDOW_MS) / 1000));
    return { allowed: false, retryAfterSec, dimension };
  }

  /**
   * 多维度依次检查：任一维度超限即拒绝（从严到松）。
   * 已通过的维度会计数（即使后续维度拒绝，已计数的不回滚——简化实现，可接受少量多计）。
   */
  async checkAll(
    dims: Array<{ dimension: string; max: number }>,
    requestId: string,
  ): Promise<RateLimitResult> {
    for (const d of dims) {
      const r = await this.check(d.dimension, d.max, requestId);
      if (!r.allowed) return r;
    }
    return { allowed: true };
  }

  /**
   * TPM 检查（token/分钟）：读当前分钟桶 + 预估 token，判断是否超限。
   * 不修改 Redis（避免并发回滚竞态）；实际 token 由 worker 结算时回填（recordTpm）。
   * 语义：窗口内已完成 token + 本次输入预占 ≤ maxTpm。
   */
  async checkTpm(
    dimension: string,
    estimatedTokens: number,
    maxTpm: number,
  ): Promise<RateLimitResult> {
    if (maxTpm <= 0) return { allowed: true }; // 无限制
    const minute = Math.floor(Date.now() / 60_000);
    const key = `tpm:${dimension}:${minute}`;
    const current = parseInt((await this.redis.get(key)) ?? '0', 10);
    if (current + estimatedTokens > maxTpm) {
      // 计算下一分钟到来的等待时间
      const retryAfterSec = Math.max(1, 60 - (Date.now() % 60_000) / 1000);
      return { allowed: false, retryAfterSec: Math.ceil(retryAfterSec), dimension };
    }
    return { allowed: true, dimension };
  }

  /**
   * TPM 多维度检查（同 checkAll 的 RPM 版）。
   * dims: [{ dimension, estimatedTokens, max }]
   */
  async checkTpmAll(
    dims: Array<{ dimension: string; estimatedTokens: number; max: number }>,
  ): Promise<RateLimitResult> {
    for (const d of dims) {
      const r = await this.checkTpm(d.dimension, d.estimatedTokens, d.max);
      if (!r.allowed) return r;
    }
    return { allowed: true };
  }

  private async ensureSha(): Promise<string> {
    if (this.sha) return this.sha;
    this.sha = (await this.redis.script('LOAD', CHECK_SCRIPT)) as unknown as string;
    return this.sha;
  }
}
