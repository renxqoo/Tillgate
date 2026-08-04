import type { BreakerState, BreakerStorage } from '../config.js';

/** 内存熔断存储：单测用 + 单机部署兜底（多实例需注入 Redis 实现） */
export class MemoryBreakerStorage implements BreakerStorage {
  private store = new Map<string, { state: BreakerState; expiresAt: number }>();

  async getState(key: string): Promise<BreakerState | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.state;
  }

  async setState(key: string, state: BreakerState, ttlMs: number): Promise<void> {
    this.store.set(key, { state, expiresAt: Date.now() + ttlMs });
  }

  /** 测试辅助：清空 */
  clear(): void {
    this.store.clear();
  }
}
