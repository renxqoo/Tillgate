import { Redis } from 'ioredis';

/**
 * 共享 Redis 单例（懒连接）。
 *
 * 用于：
 *   - 路由缓存失效（bump 版本计数器，gateway 读取）
 *   - 余额缓存失效（DEL billing:balance:*）
 *   - 登录限流（@ai-gateway/identity 用，但 identity 不持有连接，由 app 注入）
 *
 * 复用同一连接避免多开。Redis 不可用时各调用点静默容错（gateway 缓存有 TTL 兜底）。
 *
 * 懒连接 + 单例：首次调用时连接，进程退出时随进程回收。
 * 不在模块顶层 import env（避免 loadXxxEnv 在测试环境模块加载即抛 ZodError）。
 */
let redis: Redis | null = null;

/**
 * 共享 Redis 单例（懒连接）。
 * 用于路由缓存失效（bump 版本）+ 余额缓存失效 + 登录限流。复用同一连接避免多开。
 */
export function getSharedRedis(): Redis {
  if (!redis) {
    // 懒读 REDIS_URL（避免模块加载时触发 env 校验）
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // 低频失效：超时短，不阻塞响应太久
      connectTimeout: 1_000,
    });
  }
  return redis;
}

/** 测试用：注入 mock redis（绕过真实连接） */
export function setRedisForTest(mock: unknown): void {
  redis = mock as Redis;
}
