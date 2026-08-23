/**
 * Redis 固定窗计数器：INCR + 首次 EXPIRE（v1 createRedisFixedWindowCounter 语义）。
 * 同时满足 billing RateCounterPort（兑换/下单闸）与本 app 注册 IP 闸。
 */
import type { Redis } from 'ioredis';

export interface FixedWindowCounter {
  hit(key: string, windowSeconds: number): Promise<number>;
}

export function createRedisFixedWindowCounter(redis: Redis, namespace: string): FixedWindowCounter {
  const keyOf = (key: string) => `${namespace}:${key}`;
  return {
    async hit(key, windowSeconds) {
      const n = await redis.incr(keyOf(key));
      if (n === 1) {
        // 窗口锚定首个请求；进程在两命令间崩溃的残留键由 Redis maxmemory 策略兜底
        await redis.expire(keyOf(key), windowSeconds);
      }
      return n;
    },
  };
}
