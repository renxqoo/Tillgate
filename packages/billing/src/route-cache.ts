import { getSharedRedis } from './redis.js';

/**
 * 路由缓存失效（bump 版本计数器）。
 *
 * gateway 的 route-cache.ts 用版本计数失效：任何对 providers/channels/model_mappings/
 * model_channels 的写操作后 bump 一次，gateway 下次读发现版本变了就重建缓存。
 *
 * 各 api（admin-api/client-api）与 gateway 共享同一 Redis（同 REDIS_URL），此处只需 INCR 同一个 key。
 * Redis 不可用时静默（gateway 缓存有 5min TTL 兜底，且写操作低频）。
 */
const VERSION_KEY = 'route:cache:v';

/**
 * 失效 gateway 路由缓存（bump 版本）。
 * 任何 provider/channel/model/model_channel 写操作后调用（fire-and-forget，不阻塞响应）。
 */
export function invalidateRouteCache(): void {
  const r = getSharedRedis();
  void r.incr(VERSION_KEY).catch(() => {
    // Redis 不可用：静默（gateway 缓存 TTL 5min 兜底）
  });
}
