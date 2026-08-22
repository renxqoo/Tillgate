/**
 * 测试装置子入口（@tokenlens/runtime/testing）：只许 *.test.ts / 测试装配引用，
 * 不进根入口——vitest 语义不得混入生产 bundle（IMPLEMENTATION.md §3.1）。
 */
import { Redis } from 'ioredis';

/** REDIS_URL 非空才返回（describe.skipIf 判据；本地无 Redis 的环境不阻塞门禁，CI 必配） */
export function testRedisUrl(): string | undefined {
  const url = process.env.REDIS_URL;
  return url != null && url !== '' ? url : undefined;
}

/** 测试/装配辅助：等冷连接就绪（offline queue 关闭时首个命令会拒绝）；超时返回 false */
export async function waitForRedisReady(redis: Redis, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await redis.ping()) === 'PONG') return true;
    } catch {
      /* 未就绪，继续等 */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 连接测试 Redis 并等就绪；REDIS_URL 未配置返回 null（用方整套跳过）。
 * 已配置但未就绪抛错——配置了却连不上是环境问题，静默 skip 会掩盖配置错误。
 * 连接取快速失败选项（对齐 createRedisClient）：不可达时 ping 立即拒绝，
 * deadline 才真正生效（默认 offline queue 会让 ping 挂到无限重试）。
 */
export async function connectTestRedis(timeoutMs = 3_000): Promise<Redis | null> {
  const url = testRedisUrl();
  if (url === undefined) return null;
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  if (!(await waitForRedisReady(redis, timeoutMs))) {
    redis.disconnect();
    throw new Error(`REDIS_URL configured but Redis not ready: ${url}`);
  }
  return redis;
}

/** 测试收尾：优雅断开；已断开/失败时兜底强制断开 */
export async function disconnectTestRedis(redis: Redis | null): Promise<void> {
  if (redis == null) return;
  await redis.quit().catch(() => redis.disconnect());
}
