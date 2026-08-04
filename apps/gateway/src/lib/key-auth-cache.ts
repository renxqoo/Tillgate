import type { Redis } from 'ioredis';

/**
 * 鉴权 Redis 缓存（S5，requirements 4.2）。
 *
 * 静态 Key（ag_ 前缀）每次鉴权要查 DB（apiKeys + rateCardCoefficients），
 * 百万 QPS 下 PG 是瓶颈。用 Redis 缓存 keyHash → 鉴权快照：
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

const KEY_PREFIX = 'auth:key:';

/** 缓存的鉴权快照（从 DB 查到的 apiKey + user + coefficient 精简版） */
export interface CachedKeyAuth {
  userId: number;
  apiKeyId: number;
  /** 0 有效 / 1 吊销 */
  status: number;
  rateCardId: number | null;
  /** 费率卡系数（毫，1.0=1000） */
  coefficientMilli: number;
  /** Key 级限流 */
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 用户状态（0 正常 / 1 封禁 / 2 注销） */
  userStatus: number;
  userRpmLimit: number | null;
  userTpmLimit: number | null;
  /** 写入缓存的时间戳（ms，用于过期判定） */
  cachedAt: number;
}

/** Redis 的最小接口（注入 ioredis 或 mock） */
export interface CacheStorage {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class KeyAuthCache {
  constructor(private readonly redis: CacheStorage) {}

  /**
   * 获取鉴权快照：先查 Redis 缓存，miss 则调 loader 查 DB 并回填。
   * @param keyHash SHA-256(token)
   * @param loader DB 查询函数（cache miss 时调用），返回 null 表示 Key 不存在
   */
  async getOrLoad(
    keyHash: string,
    loader: () => Promise<CachedKeyAuth | null>,
  ): Promise<CachedKeyAuth | null> {
    const cacheKey = KEY_PREFIX + keyHash;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedKeyAuth;
        // 过期判定（兜底：TTL 自然过期，但 JSON 里也存了 cachedAt 防边界）
        if (Date.now() - parsed.cachedAt < KEY_AUTH_TTL_S * 1000) {
          return parsed;
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
        await this.redis.setex(cacheKey, KEY_AUTH_TTL_S, JSON.stringify(fresh));
      } catch {
        // Redis 写失败 → fail-open（本次返回结果，下次仍查 DB）
      }
    }
    return fresh;
  }

  /** 吊销/禁用 Key 时清缓存（管理端调用，加速失效） */
  async invalidate(keyHash: string): Promise<void> {
    try {
      await this.redis.del(KEY_PREFIX + keyHash);
    } catch {
      // 忽略：TTL 60s 兜底
    }
  }
}

/** 适配 ioredis 到 CacheStorage 接口 */
export function createRedisKeyAuthCache(redis: Redis): KeyAuthCache {
  return new KeyAuthCache(redis);
}
