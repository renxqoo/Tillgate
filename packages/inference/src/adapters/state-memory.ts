import type { HealthStore, Versioned } from '../ports/state';

/**
 * 内存 CAS 存储（单副本开发/测试形态；v1 gateway/worker 内存 storages 合一迁移）。
 * 语义对齐 redis 适配器：版本化 CAS + TTL 懒过期；读写值深拷贝（状态机持有者
 * 不得穿透引用污染存储）。多实例部署不适用（无跨进程原子性）。
 */
export function createMemoryHealthStore(now: () => number = Date.now): HealthStore {
  const slots = new Map<string, { value: Versioned; expiresAt: number }>();

  const read = (key: string): { value: Versioned; expiresAt: number } | undefined => {
    const slot = slots.get(key);
    if (slot == null) return undefined;
    if (now() >= slot.expiresAt) {
      slots.delete(key);
      return undefined;
    }
    return slot;
  };

  return {
    async getState<T extends Versioned>(key: string): Promise<T | null> {
      const slot = read(key);
      return slot == null ? null : (structuredClone(slot.value) as T);
    },
    // eslint-disable-next-line max-params -- 实现 HealthStore 端口契约(键/期望版本/新值/TTL),签名随端口走
    async compareAndSet<T extends Versioned>(
      key: string,
      expectedVersion: number,
      next: T,
      ttlMs: number,
    ): Promise<boolean> {
      const slot = read(key);
      if (slot == null) {
        if (expectedVersion !== 0) return false;
      } else if (slot.value.version !== expectedVersion) {
        return false;
      }
      slots.set(key, { value: structuredClone(next), expiresAt: now() + ttlMs });
      return true;
    },
  };
}
