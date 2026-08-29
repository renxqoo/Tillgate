/**
 * 智能路由策略热源（gateway 装配桥）：routing_policies 表 TTL 拾取 → 内存
 * latest（请求路径微秒级读，零 IO）。坏值韧性：解析失败沿用上一份好值；
 * 无配置回落编译期缺省——路由永不因配置缺失/损坏而挂。管理台保存后
 * ≤ttlMs 生效（不重启）。cache 亲和 sticky 键存 Redis（进程间共享，
 * TTL 对齐上游 cache 档）。
 */
import type Redis from 'ioredis';
import type { Db } from '@tillgate/db';
import { postgresRoutingPolicyStore } from '@tillgate/control-plane/composition';
import type { RoutingPolicyStore } from '@tillgate/control-plane';
import {
  defaultRoutingPolicy,
  routingPolicySchema,
  type RoutingPolicyReader,
  type StickyStore,
} from '@tillgate/inference';

const STICKY_PREFIX = 'inference:sticky:';

export interface RoutingPolicySource {
  reader: RoutingPolicyReader;
  /** 后台刷新启动（装配后调用一次；返回停止面——shutdown/测试收口定时器） */
  start(): () => void;
}

export function createRoutingPolicySource(env: {
  db: Db;
  /** 策略行存储（缺省 postgres 适配器；测试注入内存替身） */
  store?: Pick<RoutingPolicyStore, 'findGlobal'>;
  ttlMs: number;
  onFault?: (error: unknown, context: string) => void;
}): RoutingPolicySource {
  const note =
    env.onFault ??
    ((error: unknown, context: string) => console.error(`[gateway.routing] ${context}:`, error));
  const store = env.store ?? postgresRoutingPolicyStore;
  let current = defaultRoutingPolicy();
  const refresh = async (): Promise<void> => {
    try {
      const row = await store.findGlobal(env.db);
      if (row == null) return; // 无配置：保持现值（首启为编译缺省）
      current = routingPolicySchema.parse(row.policy); // 坏值抛出 → 沿用旧值
    } catch (error) {
      note(error, 'policy refresh');
    }
  };
  return {
    reader: {
      latest: () => current,
    },
    start(): () => void {
      void refresh();
      const timer = setInterval(() => {
        void refresh();
      }, env.ttlMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** Redis sticky 键（channelId 数字串 + TTL；进程间共享） */
export function createRedisStickyStore(redis: Pick<Redis, 'get' | 'set'>): StickyStore {
  return {
    async get(key) {
      const raw = await redis.get(STICKY_PREFIX + key);
      const id = raw == null ? Number.NaN : Number(raw);
      return Number.isInteger(id) && id > 0 ? id : null;
    },
    async set(key, channelId, ttlMs) {
      await redis.set(STICKY_PREFIX + key, String(channelId), 'PX', ttlMs);
    },
  };
}
