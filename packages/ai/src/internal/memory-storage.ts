/**
 * 内存 KV 状态存储（单一实现，Breaker / DeadCredential 共用）。
 *
 * 两个存储接口（BreakerStorage / DeadCredentialStorage）结构同构（见 config.ts
 * 注释），Redis 实现与本内存实现均为单一泛型类同时服务两者（与 RedisKvStorage
 * 的处理方式一致），不保留两份逐字节相同的拷贝。
 *
 * 用途：单进程调用方（如管理端渠道探测——刻意与网关熔断状态隔离）与测试的
 * **显式注入**实现（库不做默认退化，见 AiDeps 注释）；多实例共享状态必须
 * 注入 Redis 实现。compareAndSet 在 Node 单线程内天然原子（Map 操作不跨
 * await），语义与 Redis 实现一致；TTL 过期在读取时惰性清理。
 */
export class MemoryKvStorage<T extends { version: number }> {
  private store = new Map<string, { state: T; expiresAt: number }>();

  async getState(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.state;
  }

  async compareAndSet(
    key: string,
    expectedVersion: number,
    next: T,
    ttlMs: number,
  ): Promise<boolean> {
    const entry = this.store.get(key);
    const currentVersion = entry && entry.expiresAt >= Date.now() ? entry.state.version : 0;
    if (currentVersion !== expectedVersion) return false;
    this.store.set(key, { state: next, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async setState(key: string, state: T, ttlMs: number): Promise<void> {
    this.store.set(key, { state, expiresAt: Date.now() + ttlMs });
  }

  /** 测试辅助：清空 */
  clear(): void {
    this.store.clear();
  }
}
