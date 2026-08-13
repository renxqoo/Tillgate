import { Redis } from 'ioredis';

// 值转发：app/测试需要构造真实 Redis 实例（类型随类名一起导出）
export { Redis } from 'ioredis';

/**
 * Redis 连接工厂（无单例、无测试污染 hook）。
 * 连接由 app 组装层创建并经依赖注入传递，路由/服务不再直读 process.env。
 */
export function createRedis(
  url: string,
  opts: { maxRetriesPerRequest?: number; connectTimeout?: number } = {},
): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 1,
    connectTimeout: opts.connectTimeout ?? 1_000,
  });
}
