import { Redis } from 'ioredis';

/**
 * 路由缓存失效（bump 版本计数器）。
 *
 * gateway 的 route-cache.ts 用版本计数失效：任何对 providers/channels/model_mappings/
 * model_channels 的写操作后 bump 一次，gateway 下次读发现版本变了就重建缓存。
 *
 * admin-api 与 gateway 共享同一 Redis（同 REDIS_URL），此处只需 INCR 同一个 key。
 * Redis 不可用时静默（gateway 缓存有 5min TTL 兜底，且 admin 写操作低频）。
 *
 * 注意：懒连接 + 单例——首次调用时连接，进程退出时随进程回收。
 * 不在模块顶层 import env（避免 loadAdminApiEnv 在测试环境模块加载即抛 ZodError）。
 */
const VERSION_KEY = 'route:cache:v';
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    // 懒读 REDIS_URL（避免模块加载时触发 env 校验）
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // 低频失效：超时短，不阻塞 admin 响应太久
      connectTimeout: 1_000,
    });
  }
  return redis;
}

/**
 * 失效 gateway 路由缓存（bump 版本）。
 * 任何 provider/channel/model/model_channel 写操作后调用（fire-and-forget，不阻塞响应）。
 */
export function invalidateRouteCache(): void {
  const r = getRedis();
  void r.incr(VERSION_KEY).catch(() => {
    // Redis 不可用：静默（gateway 缓存 TTL 5min 兜底）
  });
}

/** 测试用：注入 mock redis（绕过真实连接） */
export function setRedisForTest(mock: unknown): void {
  redis = mock as Redis;
}

