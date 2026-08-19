/**
 * ai 状态存储的进程内存实现（单副本语义）。
 * ai 包刻意不提供默认实现（多实例必须显式声明状态语义）——本实现用于 gateway-v2
 * 起步；多副本部署替换为 Redis 实现（老 gateway infrastructure/ai-storage.ts 是参照，
 * Lua CAS 保证 GET+条件 SET 原子）。接口同构（Breaker/DeadCredential）共用一个泛型。
 */
import type {
  BreakerState,
  BreakerStorage,
  DeadCredentialState,
  DeadCredentialStorage,
} from '@ai-gateway/ai';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

class MemoryStateStorage<T extends { version: number }> {
  private readonly map = new Map<string, Entry<T>>();

  async getState(key: string): Promise<T | null> {
    const entry = this.map.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  async compareAndSet(key: string, expectedVersion: number, next: T, ttlMs: number): Promise<boolean> {
    const current = await this.getState(key);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.map.set(key, { value: next, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async setState(key: string, state: T, ttlMs: number): Promise<void> {
    this.map.set(key, { value: state, expiresAt: Date.now() + ttlMs });
  }
}

export function createMemoryAiStorages(): { breakerStorage: BreakerStorage; deadCredentialStorage: DeadCredentialStorage } {
  return {
    breakerStorage: new MemoryStateStorage<BreakerState>(),
    deadCredentialStorage: new MemoryStateStorage<DeadCredentialState>(),
  };
}
