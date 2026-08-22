import { describe, expect, it } from 'vitest';
import { createMemoryHealthStore } from '../src/adapters/state-memory';

interface S {
  version: number;
  count: number;
}

describe('adapters/state-memory：版本化 CAS + TTL 懒过期', () => {
  it('无状态 + expectedVersion 0 可写入；非 0 期望对无状态拒绝', async () => {
    const store = createMemoryHealthStore();
    expect(await store.compareAndSet<S>('k', 0, { version: 1, count: 1 }, 1_000)).toBe(true);
    expect((await store.getState<S>('k'))?.count).toBe(1);
    const store2 = createMemoryHealthStore();
    expect(await store2.compareAndSet<S>('k', 3, { version: 4, count: 1 }, 1_000)).toBe(false);
  });

  it('版本不匹配拒绝；匹配则整体替换并刷新 TTL', async () => {
    const store = createMemoryHealthStore();
    await store.compareAndSet<S>('k', 0, { version: 1, count: 1 }, 1_000);
    expect(await store.compareAndSet<S>('k', 5, { version: 6, count: 2 }, 1_000)).toBe(false);
    expect(await store.compareAndSet<S>('k', 1, { version: 2, count: 2 }, 1_000)).toBe(true);
    expect((await store.getState<S>('k'))?.count).toBe(2);
  });

  it('TTL 到期后视为无状态（懒过期——不依赖后台扫描）', async () => {
    let now = 1_000;
    const store = createMemoryHealthStore(() => now);
    await store.compareAndSet<S>('k', 0, { version: 1, count: 1 }, 100);
    now = 1_200; // 已过期
    expect(await store.getState<S>('k')).toBeNull();
    expect(await store.compareAndSet<S>('k', 1, { version: 2, count: 9 }, 100)).toBe(false);
    expect(await store.compareAndSet<S>('k', 0, { version: 1, count: 9 }, 100)).toBe(true);
  });

  it('读写深拷贝：状态机持有者改返回对象不污染存储', async () => {
    const store = createMemoryHealthStore();
    await store.compareAndSet<S>('k', 0, { version: 1, count: 1 }, 1_000);
    const state = await store.getState<S>('k');
    state!.count = 99;
    expect((await store.getState<S>('k'))?.count).toBe(1);
  });
});
