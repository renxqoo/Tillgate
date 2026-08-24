/**
 * 调度器规格：tick 错误隔离（job 抛错不崩调度）、stop 拒新+宽限、
 * 快照更新、无立即首跑（interval 到点才触发——v1 同款）。
 */
import { describe, expect, it, vi } from 'vitest';
import { defined } from './defined.js';
import { createScheduler } from '../src/scheduler';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createScheduler', () => {
  it('tick 错误隔离：job 抛错记 onError 不崩、快照记 lastError', async () => {
    const errors: Array<{ error: unknown; name: string }> = [];
    const scheduler = createScheduler({
      graceMs: 100,
      onError: (error, name) => errors.push({ error, name }),
      now: () => new Date('2026-08-23T00:00:00Z'),
    });
    let calls = 0;
    scheduler.register({
      name: 'boom',
      intervalMs: 5,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('job down');
        return { ok: true };
      },
    });
    scheduler.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    await scheduler.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // 首次失败后调度继续
    expect(errors).toEqual([{ error: new Error('job down'), name: 'boom' }]);
    const snapshot = defined(scheduler.snapshots()['boom'], "snapshots()['boom']");
    expect(snapshot.lastError).toBe('job down');
    expect(snapshot.lastStartedAt).toBe('2026-08-23T00:00:00.000Z');
  });

  it('stop 拒新批次并等待在途完成（宽限内）', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const scheduler = createScheduler({ graceMs: 5_000, onError: () => {} });
      let started = 0;
      let finished = 0;
      scheduler.register({
        name: 'slow',
        intervalMs: 1_000,
        run: async () => {
          started += 1;
          await gate.promise;
          finished += 1;
        },
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000); // 首轮触发，挂在 gate
      expect(started).toBe(1);
      const stopping = scheduler.stop();
      await vi.advanceTimersByTimeAsync(3_000); // 停收后 interval 不再触发
      expect(started).toBe(1);
      gate.resolve();
      await stopping;
      expect(finished).toBe(1);
      expect(scheduler.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop 宽限耗尽不强等（宽限上界封口）', async () => {
    const scheduler = createScheduler({ graceMs: 10, onError: () => {} });
    const gate = deferred();
    scheduler.register({ name: 'stuck', intervalMs: 1, run: () => gate.promise });
    scheduler.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
    const startedAt = Date.now();
    await scheduler.stop(); // stuck 未完成——10ms 宽限后返回
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    gate.resolve();
  });

  it('start 前不触发（无立即首跑）；快照未运行为 null', async () => {
    const scheduler = createScheduler({ graceMs: 100, onError: () => {} });
    let calls = 0;
    scheduler.register({ name: 'x', intervalMs: 5, run: async () => (calls += 1) });
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
    expect(calls).toBe(0);
    expect(scheduler.snapshots().x).toBeNull();
    expect(scheduler.isRunning()).toBe(false);
  });
});

describe('createScheduler vi 定时器口径', () => {
  it('interval 到点触发一次（非立即）', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createScheduler({ graceMs: 100, onError: () => {} });
      const runs: number[] = [];
      scheduler.register({
        name: 't',
        intervalMs: 1_000,
        run: async () => void runs.push(Date.now()),
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(runs.length).toBe(2); // 1s、2s 两次；0s 不触发
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
