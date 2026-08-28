/**
 * DB 并发预算门行为规格（F-6 预算门的核心机制锁）：
 * 计数/FIFO 排队/溢出 fail-closed(db_budget_full)/等待超时(db_budget_timeout)/
 * 探针旁路/预算推导 suggestDbBudget。错误统一走 http 目录码(unavailable→503)。
 * 取消感知族（db-budget-signals 方案）：排队中客户端断连出队(db_budget_abandoned)、
 * 入口即断连短路、授予后断连无 late-reject、drain 排水清队与新到拒流(db_budget_draining)。
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

const fakeContext = (path: string, signal?: AbortSignal) =>
  ({ req: { path, raw: { signal: signal ?? new AbortController().signal } } }) as never;

/** 目录码错误判定：unavailable 族专属形状 */
const isUnavailableCode = (err: unknown, code: string): boolean => {
  const e = err as BusinessError & CatalogErrorShape;
  return e instanceof BusinessError && e.code === code && e.category === 'unavailable';
};

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

describe('dbBudgetMiddleware 取消感知（db-budget-signals 方案）', () => {
  it('排队中客户端断连 → 出队 + db_budget_abandoned,其余排队者 FIFO 保序', async () => {
    const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 10, waitTimeoutMs: 5_000 });
    const gate = latch();
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const holder = mw(fakeContext('/hold'), gate.next);
    const a = immediateNext();
    const b = immediateNext();
    const pA = mw(fakeContext('/a', ctrlA.signal), a.next);
    const pB = mw(fakeContext('/b', ctrlB.signal), b.next);
    const rejectedA = expect(pA).rejects.toSatisfy((err: unknown) =>
      isUnavailableCode(err, 'http.db_budget_abandoned'),
    );
    ctrlA.abort();
    await rejectedA;
    expect(a.spy).not.toHaveBeenCalled(); // 出局者不执行业务链
    gate.open();
    await holder;
    await vi.waitFor(() => expect(b.spy).toHaveBeenCalledTimes(1)); // B 顶上,死请求不占名额
    expect(await pB).toBe('served');
  });

  it('入口即断连 → db_budget_abandoned,不占预算(后续请求仍直通)', async () => {
    const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 10, waitTimeoutMs: 1_000 });
    const ctrl = new AbortController();
    ctrl.abort();
    const dead = immediateNext();
    await expect(mw(fakeContext('/gone', ctrl.signal), dead.next)).rejects.toSatisfy((err) =>
      isUnavailableCode(err, 'http.db_budget_abandoned'),
    );
    expect(dead.spy).not.toHaveBeenCalled();
    const live = immediateNext();
    await expect(mw(fakeContext('/live'), live.next)).resolves.toBe('served');
  });

  it('授予后断连 → 无 late-reject,请求照常完成(唤醒源已拆除)', async () => {
    const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 10, waitTimeoutMs: 5_000 });
    const gate = latch();
    const ctrl = new AbortController();
    const holder = mw(fakeContext('/hold'), gate.next);
    const served = immediateNext();
    const p = mw(fakeContext('/q', ctrl.signal), served.next);
    gate.open();
    await holder;
    expect(await p).toBe('served');
    ctrl.abort(); // 已结算的等待不受拆除后的信号影响(无未处理拒绝即通过)
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  });

  it('drainSignal abort → 全体排队者 db_budget_draining,新到立即拒,在途自然完成', async () => {
    const drain = new AbortController();
    const mw = dbBudgetMiddleware({
      limit: 1,
      maxQueue: 10,
      waitTimeoutMs: 5_000,
      drainSignal: drain.signal,
    });
    const gate = latch();
    const q1 = immediateNext();
    const q2 = immediateNext();
    const holder = mw(fakeContext('/hold'), gate.next);
    const p1 = mw(fakeContext('/q1'), q1.next);
    const p2 = mw(fakeContext('/q2'), q2.next);
    const rejected1 = expect(p1).rejects.toSatisfy((err) =>
      isUnavailableCode(err, 'http.db_budget_draining'),
    );
    const rejected2 = expect(p2).rejects.toSatisfy((err) =>
      isUnavailableCode(err, 'http.db_budget_draining'),
    );
    drain.abort();
    await rejected1;
    await rejected2;
    expect(q1.spy).not.toHaveBeenCalled();
    expect(q2.spy).not.toHaveBeenCalled();
    const after = immediateNext();
    await expect(mw(fakeContext('/after'), after.next)).rejects.toSatisfy((err) =>
      isUnavailableCode(err, 'http.db_budget_draining'),
    );
    expect(after.spy).not.toHaveBeenCalled();
    gate.open(); // 已授予的 in-flight 不受 drain 影响,宽限内自然完成
    await holder;
  });

  it('drain 后探针仍旁路(LB 摘除探活不能停)', async () => {
    const drain = new AbortController();
    drain.abort();
    const mw = dbBudgetMiddleware({
      limit: 1,
      maxQueue: 1,
      waitTimeoutMs: 100,
      drainSignal: drain.signal,
    });
    const probe = immediateNext();
    await expect(mw(fakeContext('/healthz'), probe.next)).resolves.toBe('served');
    expect(probe.spy).toHaveBeenCalledTimes(1);
  });

  it('超时先于断连:出局码是 timeout,后续 abort 无副作用', async () => {
    vi.useFakeTimers();
    const gate = latch();
    const ctrl = new AbortController();
    try {
      const mw = dbBudgetMiddleware({ limit: 1, maxQueue: 5, waitTimeoutMs: 300 });
      const holder = mw(fakeContext('/hold'), gate.next);
      void holder;
      const queued = immediateNext();
      const p = mw(fakeContext('/q', ctrl.signal), queued.next);
      const assertion = expect(p).rejects.toSatisfy((err: unknown) =>
        isUnavailableCode(err, 'http.db_budget_timeout'),
      );
      await vi.advanceTimersByTimeAsync(400);
      await assertion;
      ctrl.abort(); // 已出局,abort 不再产生任何拒绝
      expect(queued.spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      gate.open();
    }
  });
});
