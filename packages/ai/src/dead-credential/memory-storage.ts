import type { DeadCredentialState, DeadCredentialStorage } from '../config.js';

/**
 * 内存死凭据存储：单测用 + 单机部署兜底（多实例需注入 Redis 实现）。
 * compareAndSet 在 Node 单线程内天然原子（Map 操作不跨 await），语义与 Redis 实现一致。
 */
export class MemoryDeadCredentialStorage implements DeadCredentialStorage {
  private store = new Map<string, { state: DeadCredentialState; expiresAt: number }>();

  async getState(key: string): Promise<DeadCredentialState | null> {
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
    next: DeadCredentialState,
    ttlMs: number,
  ): Promise<boolean> {
    const entry = this.store.get(key);
    const currentVersion = entry && entry.expiresAt >= Date.now() ? entry.state.version : 0;
    if (currentVersion !== expectedVersion) return false;
    this.store.set(key, { state: next, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async setState(key: string, state: DeadCredentialState, ttlMs: number): Promise<void> {
    this.store.set(key, { state, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
