/**
 * 固定窗口计数器（Redis INCR+EXPIRE；fail-closed）：注册 per-IP / 兑换 per-user
 * 频率闸共用。Redis 故障时向上抛错——调用方按 503 拒绝（兑换爆破/注册农场恰好
 * 会在 Redis 抖动窗口内发动，fail-open 等于在最需要时拆掉闸门）。
 * 无 Redis = 单副本开发形态，注入 null 即跳过。
 */
import type { Redis } from 'ioredis';

export interface FixedWindowCounter {
  /** 记一次并返回窗口内累计（Redis 故障向上抛——调用方 fail-closed） */
  hit(key: string, windowS: number): Promise<number>;
}

export function createRedisFixedWindowCounter(redis: Redis, prefix: string): FixedWindowCounter {
  return {
    async hit(key, windowS) {
      const k = `${prefix}:${key}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, windowS);
      return n;
    },
  };
}
