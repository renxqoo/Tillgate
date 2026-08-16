import type { Redis } from './redis.js';

/**
 * 网关共享缓存键与失效操作（单一来源，防键格式漂移）。
 *
 * 这些键由 apps/gateway 消费：
 *   - auth:key:{hash}：Key 鉴权快照（TTL 60s，网关 KeyAuthCache）
 *   - app_status:{id}：App 状态快照（已签发 JWT 即时失效用）
 *   - billing:balance:{userId}：余额快照
 *   - route:cache:v：路由/渠道缓存版本计数（网关 model-router 检测变化后重建）
 *
 * 注意：网关侧仍持有自己的键实现（历史边界），若网关后续收敛到本包，
 * 键格式以此文件为准。
 */

/** 路由缓存版本计数键 */
export const ROUTE_CACHE_VERSION_KEY = 'route:cache:v';

export function authKeyCache(keyHash: string): string {
  return `auth:key:${keyHash}`;
}

export function appStatusCache(appId: number | string): string {
  return `app_status:${appId}`;
}

export function balanceCache(userId: number): string {
  return `billing:balance:${userId}`;
}

/** 用户限流画像快照（rpm/tpm 约束；网关 auth-service 消费） */
export function userProfileCache(userId: number): string {
  return `user_profile:${userId}`;
}

/**
 * 路由缓存失效：bump 版本计数，网关检测到版本变化后重建路由缓存。
 * Redis 不可用时静默降级（网关侧有自身的缓存 TTL 兜底）。
 */
export async function bumpRouteCache(redis: Redis): Promise<void> {
  await redis.incr(ROUTE_CACHE_VERSION_KEY).catch(() => {});
}

/**
 * 清 Key 鉴权缓存：吊销/限流变更立即生效，无需等网关 60s TTL。
 * 单条失败不影响其余（fail-open，TTL 兜底）。
 */
export async function invalidateKeyAuthCache(redis: Redis, keyHashes: string[]): Promise<void> {
  if (keyHashes.length === 0) return;
  await Promise.all(keyHashes.map((h) => redis.del(authKeyCache(h)).catch(() => {})));
}
