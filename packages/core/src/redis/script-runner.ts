/**
 * Redis Lua 脚本运行器（v1 infrastructure/redis-script-runner 的下沉移植）：
 * evalsha + NOSCRIPT 自愈。
 *
 * Redis 官方规定的恢复模式：evalsha 收到 NOSCRIPT（脚本未缓存——重启、故障转移、
 * SCRIPT FLUSH 后）→ 重新 LOAD → 重试。sha 是脚本人的确定性哈希，重载返回同值，
 * 重试即自愈（BUG-C，new-api #6412 同类：缓存永不重载导致 Redis 重启后持续抛错）。
 */
import type { Redis, RedisValue } from 'ioredis';

export interface RedisScriptRunner {
  run(script: string, numKeys: number, ...args: RedisValue[]): Promise<unknown>;
}

export function createRedisScriptRunner(redis: Redis): RedisScriptRunner {
  const shas = new Map<string, string>();
  return {
    async run(script, numKeys, ...args) {
      const cached = shas.get(script);
      if (cached !== undefined) {
        try {
          return await redis.evalsha(cached, numKeys, ...args);
        } catch (err) {
          if (!isNoScriptError(err)) throw err;
          // NOSCRIPT：脚本缓存消失，走重载路径
        }
      }
      const sha = (await redis.script('LOAD', script)) as unknown as string;
      shas.set(script, sha);
      return redis.evalsha(sha, numKeys, ...args);
    },
  };
}

/** ioredis 把 NOSCRIPT 作为 message 前缀抛出（无独立 code） */
function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.toUpperCase().includes('NOSCRIPT');
}
