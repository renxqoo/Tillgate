/**
 * 共享 Redis 单例 + 路由缓存失效已抽到 @ai-gateway/billing。
 * 本文件重新导出，保持现有 import 可用。新代码请直接 import @ai-gateway/billing。
 *
 * 注意：原 getAdminRedis 已改名 getSharedRedis（语义中立，client-api/admin-api 共用）。
 *      此处保留 getAdminRedis 别名避免管理面路由大面积改 import。
 */
import { getSharedRedis, invalidateRouteCache, setRedisForTest } from '@ai-gateway/billing';

export { invalidateRouteCache, setRedisForTest };

/** @deprecated 用 @ai-gateway/billing 的 getSharedRedis（语义中立） */
export function getAdminRedis() {
  return getSharedRedis();
}

/** 测试用别名 */
export { getSharedRedis };
