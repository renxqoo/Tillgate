import { defaultRoutingPolicy, type RoutingPolicy } from '../routing/policy';

/**
 * 路由策略 port（消费方定义；装配注入实现）：
 *   - RoutingPolicyReader：同步读内存 latest（微秒级，请求路径零 IO）——热更新由
 *     实现方后台刷新（gateway 形态 = routing_policies 表 TTL 拾取；测试用静态实现）；
 *   - StickyStore：cache 亲和粘滞键（channelId + TTL）——生产 Redis、测试内存。
 * 两 port 均为偏好/记忆面：故障 fail-open（读不到 = 无策略退缺省 / 无粘滞），不反噬请求。
 */
export interface RoutingPolicyReader {
  latest(): RoutingPolicy;
}

/** 静态策略（缺省实现——单副本/测试；装配未注入 reader 时路由退编译期缺省） */
export function staticRoutingPolicy(policy?: RoutingPolicy): RoutingPolicyReader {
  const fixed = policy ?? defaultRoutingPolicy();
  return { latest: () => fixed };
}

/** cache 亲和粘滞键存储（键 = 路由指纹；值 = 上次成功渠道 id） */
export interface StickyStore {
  /** 命中返回渠道 id；无/过期返回 null */
  get(key: string): Promise<number | null>;
  /** 记录/续期（成功结算后调用） */
  set(key: string, channelId: number, ttlMs: number): Promise<void>;
}

/**
 * 进程内 sticky 缺省容量（单副本/测试形态）：会话指纹基数 ≈ 活跃会话 × 凭证数，
 * 万级条目（键 ~80B + 值）常驻 ≈ 1-2MB——开发/单副本足够；生产多副本装配 Redis
 * （TTL 原生淘汰）。上限只防「过期后不再被读取的键」在长寿命进程里累积
 * （过期键仍靠 get 懒删），淘汰策略 LRU（Map 迭代序 = 插入序：get 命中重排到
 * 最近使用，超限从头淘汰最久未用）。
 */
const MEMORY_STICKY_MAX_ENTRIES = 10_000;

/** 进程内 sticky（单副本/测试形态；TTL 由过期时间戳表达；超容量 LRU 淘汰） */
export function createMemoryStickyStore(
  now: () => number = Date.now,
  maxEntries: number = MEMORY_STICKY_MAX_ENTRIES,
): StickyStore {
  const map = new Map<string, { channelId: number; expiresAt: number }>();
  const evictIfNeeded = (): void => {
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    async get(key) {
      const hit = map.get(key);
      if (hit == null) return null;
      if (now() >= hit.expiresAt) {
        map.delete(key);
        return null;
      }
      // LRU：命中重排为最近使用
      map.delete(key);
      map.set(key, hit);
      return hit.channelId;
    },
    async set(key, channelId, ttlMs) {
      map.delete(key); // 重插保证「最近使用」位置（覆写续期不淘汰自己）
      map.set(key, { channelId, expiresAt: now() + ttlMs });
      evictIfNeeded();
    },
  };
}
