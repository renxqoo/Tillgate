import type { Redis } from 'ioredis';
import { authKeyCache } from '@ai-gateway/http';

/**
 * 鉴权 Redis 缓存（S5，requirements 4.2）。
 *
 * 静态 Key（ag_ 前缀）每次鉴权要查 DB（apiKeys + users），
 * 高 QPS 下 PG 是瓶颈。用 Redis 缓存 keyHash → 鉴权快照：
 *   - 命中 → 跳过 DB 查询（PG 只在 cache miss 时被命中）
 *   - TTL 60s（短暂窗口，吊销/禁用后最多 60s 失效；管理端可主动 DEL 加速）
 *   - fail-open：Redis 不可用时降级查 DB（不阻塞鉴权）
 *
 * 安全约束：
 *   - 吊销/过期的 Key（status≠0）不缓存（下次仍查 DB 确认最新状态）
 *   - null 结果不缓存（防缓存穿透）
 */

/** 缓存 TTL（秒）——短暂窗口保证吊销最终生效 */
export const KEY_AUTH_TTL_S = 60;



/** 缓存的鉴权快照（从 DB 查到的 apiKey + user 精简版） */
export interface CachedKeyAuth {
  userId: number;
  apiKeyId: number;
  /** 0 有效 / 1 吊销 */
  status: number;
  rateCardId: number | null;
  /** Key 级限流 */
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 用户状态（0 正常 / 1 封禁 / 2 注销） */
  userStatus: number;
  userRpmLimit: number | null;
  userTpmLimit: number | null;
  /**
   * Key 过期时间（ms 时间戳，null=永不过期）。
   * C4 修复：缓存层据此做过期判定，避免过期 Key 在 TTL 窗口内继续可用。
   */
  expiresAtMs: number | null;
  /** 写入缓存的时间戳（ms，用于过期判定） */
  cachedAt: number;
}

/** Redis 的最小接口（注入 ioredis 或 mock） */
export interface CacheStorage {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface KeyAuthCache {
  /**
   * 获取鉴权快照：先查 Redis 缓存，miss 则调 loader 查 DB 并回填。
   * @param keyHash SHA-256(token)
   * @param loader DB 查询函数（cache miss 时调用），返回 null 表示 Key 不存在
   */
  getOrLoad(keyHash: string, loader: () => Promise<CachedKeyAuth | null>): Promise<CachedKeyAuth | null>;
  /** 吊销/禁用 Key 时清缓存（管理端调用，加速失效） */
  invalidate(keyHash: string): Promise<void>;
}

export function createKeyAuthCache(redis: CacheStorage): KeyAuthCache {
  return {
    async getOrLoad(keyHash, loader) {
      const cacheKey = authKeyCache(keyHash);
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as CachedKeyAuth;
          // 过期判定（兜底：TTL 自然过期，但 JSON 里也存了 cachedAt 防边界）
          if (Date.now() - parsed.cachedAt < KEY_AUTH_TTL_S * 1000) {
            // C4 修复：缓存命中也判 Key 过期（expiresAtMs）。过期 → 视为失效，走 DB 重新确认。
            if (parsed.expiresAtMs !== null && parsed.expiresAtMs <= Date.now()) {
              // 失效缓存，下次重新查（过期 Key 不应继续放行）
              await redis.del(cacheKey).catch(() => {});
            } else {
              return parsed;
            }
          }
        }
      } catch {
        // Redis 不可用 → fail-open 降级查 DB
      }
      // cache miss → 查 DB
      const fresh = await loader();
      if (fresh && fresh.status === 0 && fresh.userStatus === 0) {
        // 仅有效 Key 写缓存（吊销/禁用状态不缓存，防状态过期）
        try {
          await redis.setex(cacheKey, KEY_AUTH_TTL_S, JSON.stringify(fresh));
        } catch {
          // Redis 写失败 → fail-open（本次返回结果，下次仍查 DB）
        }
      }
      return fresh;
    },

    async invalidate(keyHash) {
      try {
        await redis.del(authKeyCache(keyHash));
      } catch {
        // 忽略：TTL 60s 兜底
      }
    },
  };
}

/** 适配 ioredis 到 CacheStorage 接口 */
export function createRedisKeyAuthCache(redis: Redis): KeyAuthCache {
  return createKeyAuthCache(redis);
}
