/**
 * DB 并发预算门行为规格（F-6 预算门的核心机制锁）：
 * 计数/FIFO 排队/溢出 fail-closed(db_budget_full)/等待超时(db_budget_timeout)/
 * 探针旁路/预算推导 suggestDbBudget。错误统一走 http 目录码(unavailable→503)。
 */
import { describe, expect, it, vi } from 'vitest';
import { BusinessError } from '@tillgate/errors';
import type { Next } from 'hono';
import { dbBudgetMiddleware, suggestDbBudget } from '../src/middleware/db-budget.js';

/** 目录码错误的最小形状断言面 */
interface CatalogErrorShape {
  code?: string;
  category?: string;
  context?: { queueDepth?: number };
}

const fakeContext = (path: string) => ({ req: { path } }) as never;

/** 手动释放闩:next 挂起直到 open() —— 模拟占用 DB 并发的在途请求 */
function latch() {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.fn(() => gate);
  return { open: () => release?.(), spy, next: spy as unknown as Next };
}

/** 即时完成的 next */
function immediateNext() {
  const spy = vi.fn(async () => 'served');
  return { spy, next: spy as unknown as Next };
}

describe('dbBudgetMiddleware', () => {
  it('限额内直通,超限 FIFO 排队,释放按序放行', async () => {
    const mw = dbBudgetMiddleware({ limit: 2, maxQueue: 10, waitTimeoutMs: 1_000 });
    const gate1 = latch();
    const gate2 = latch();
    const third = immediateNext();
    const p1 = mw(fakeContext('/a'), gate1.next);
    const p2 = mw(fakeContext('/b'), gate2.next);
    void p1;
    void p2;
    expect(gate1.spy).toHaveBeenCalledTimes(1); // 两个名额即时放行
    expect(gate2.spy).toHaveBeenCalledTimes(1);
    const p3 = mw(fakeContext('/c'), third.next);
    expect(third.spy).not.toHaveBeenCalled(); // 第三个排队中
    gate1.open();
    await p1;
    await vi.waitFor(() => expect(third.spy).toHaveBeenCalledTimes(1)); // 释放即放行
    gate2.open();
    await p2;
    expect(await p3).toBe('served');
  });

  it('队列溢出 → http.db_budget_full(unavailable,fail-closed)', async () => {
    const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 1, waitTimeoutMs: 5_000 });
    const gate = latch();
    const queued = immediateNext();
    const overflow = immediateNext();
    const holder = mw(fakeContext('/hold'), gate.next);
    const queuedPromise = mw(fakeContext('/queued'), queued.next);
    void queuedPromise;
    await expect(mw(fakeContext('/overflow'), overflow.next)).rejects.toSatisfy((err: unknown) => {
      const e = err as BusinessError & CatalogErrorShape;
      return (
        e instanceof BusinessError &&
        e.code === 'http.db_budget_full' &&
        e.category === 'unavailable' &&
        e.context?.queueDepth === 1
      );
    });
    expect(overflow.spy).not.toHaveBeenCalled();
    gate.open();
    await holder;
    await queuedPromise;
  });

  it('排队超时 → http.db_budget_timeout(unavailable)', async () => {
    vi.useFakeTimers();
    const gate = latch();
    try {
      const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 5, waitTimeoutMs: 300 });
      const holder = mw(fakeContext('/hold'), gate.next);
      void holder;
      const queued = immediateNext();
      const p = mw(fakeContext('/slow'), queued.next);
      const assertion = expect(p).rejects.toSatisfy((err: unknown) => {
        const e = err as BusinessError & CatalogErrorShape;
        return (
          e instanceof BusinessError &&
          e.code === 'http.db_budget_timeout' &&
          e.category === 'unavailable'
        );
      });
      await vi.advanceTimersByTimeAsync(400);
      await assertion;
      expect(queued.spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      gate.open();
    }
  });

  it('探针路径旁路:不占预算不排队', async () => {
    const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 1, waitTimeoutMs: 100 });
    const gate = latch();
    const holder = mw(fakeContext('/biz'), gate.next);
    void holder;
    const probe = immediateNext();
    await expect(mw(fakeContext('/healthz'), probe.next)).resolves.toBe('served');
    expect(probe.spy).toHaveBeenCalledTimes(1);
    gate.open();
    await holder;
  });

  it('suggestDbBudget:limit=池−余量(下限 1),queue/timeout 定值', () => {
    expect(suggestDbBudget(210, 32)).toEqual({
      limit: 178,
      maxQueue: 20_000,
      waitTimeoutMs: 120_000,
    });
    expect(suggestDbBudget(10)).toEqual({ limit: 8, maxQueue: 20_000, waitTimeoutMs: 120_000 });
    expect(suggestDbBudget(2)).toEqual({ limit: 1, maxQueue: 20_000, waitTimeoutMs: 120_000 });
    expect(suggestDbBudget(1)).toEqual({ limit: 1, maxQueue: 20_000, waitTimeoutMs: 120_000 });
  });
});
