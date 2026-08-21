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
  // INCR+EXPIRE 单脚本原子化：两步写法在「首 INCR 后进程崩溃」窗口会留下无 TTL
  // 键 → 该桶永久计数、用户被永久 429——计数与设 TTL 必须一次原子完成
  const script = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n
` as string;
  return {
    async hit(key, windowS) {
      const n = (await redis.eval(script, 1, `${prefix}:${key}`, windowS)) as number;
      return n;
    },
  };
}
