import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@ai-gateway/db';
import { createAdmission } from '../billing/authorize/admission.js';
import { BillingBacklogError } from '../billing/errors.js';

/**
 * 准入闸（admission）行为契约（纯单元，无 DB 依赖）：
 *   1. 两个维度独立触发拒绝：pending 深度、最老账单年龄
 *   2. 拒绝结果同样进缓存——过载期间准入查询不重复打 DB（自我保护）
 *   3. cacheMs 内命中缓存不重复查询
 *   4. 缓存空时并发调用共享同一探针（单飞合并）
 *   5. 探针失败传播给所有等待者，且 probe 复位——下一次调用重新查询
 */

interface InventoryRow {
  pending: string;
  oldest_pending_at: Date | string | null;
}

function stubDb() {
  return { execute: vi.fn() } as unknown as Db;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GATE = { maxPending: 10, maxOldestAgeMs: 5_000, cacheMs: 60_000 };

describe('admission：积压准入闸', () => {
  it('pending 深度与最老年龄两个维度独立触发拒绝', async () => {
    const deep = stubDb();
    (deep.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ pending: '11', oldest_pending_at: null }] satisfies InventoryRow[],
    });
    await expect(createAdmission(deep, GATE).assertCapacity()).rejects.toBeInstanceOf(
      BillingBacklogError,
    );

    const stale = stubDb();
    (stale.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        { pending: '0', oldest_pending_at: new Date(Date.now() - 10_000).toISOString() },
      ] satisfies InventoryRow[],
    });
    await expect(createAdmission(stale, GATE).assertCapacity()).rejects.toBeInstanceOf(
      BillingBacklogError,
    );

    const healthy = stubDb();
    (healthy.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        // 4s < 5s 阈值：留 1s 余量，避免时敏边界偶发翻转
        { pending: '9', oldest_pending_at: new Date(Date.now() - 4_000).toISOString() },
      ] satisfies InventoryRow[],
    });
    await expect(createAdmission(healthy, GATE).assertCapacity()).resolves.toBeUndefined();
  });

  it('拒绝结果同样进缓存：过载期间不重复查询（准入自我保护）', async () => {
    const db = stubDb();
    const admission = createAdmission(db, GATE);
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [{ pending: '99', oldest_pending_at: null }] satisfies InventoryRow[],
    });

    await expect(admission.assertCapacity()).rejects.toBeInstanceOf(BillingBacklogError);
    await expect(admission.assertCapacity()).rejects.toBeInstanceOf(BillingBacklogError);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('cacheMs 内命中缓存：多次调用只查询一次', async () => {
    const db = stubDb();
    const admission = createAdmission(db, GATE);
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [{ pending: '1', oldest_pending_at: null }] satisfies InventoryRow[],
    });

    await admission.assertCapacity();
    await admission.assertCapacity();
    await admission.assertCapacity();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('缓存空时并发调用单飞合并：共享同一探针', async () => {
    const db = stubDb();
    const admission = createAdmission(db, GATE);
    const probe = deferred<{ rows: InventoryRow[] }>();
    (db.execute as ReturnType<typeof vi.fn>).mockReturnValueOnce(probe.promise);

    const first = admission.assertCapacity();
    const second = admission.assertCapacity();
    probe.resolve({ rows: [{ pending: '1', oldest_pending_at: null }] });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('探针失败传播给所有等待者，probe 复位后可重试', async () => {
    const db = stubDb();
    const admission = createAdmission(db, GATE);
    const probe = deferred<{ rows: InventoryRow[] }>();
    (db.execute as ReturnType<typeof vi.fn>).mockReturnValueOnce(probe.promise);

    const first = admission.assertCapacity();
    const second = admission.assertCapacity();
    probe.reject(new Error('db down'));
    await expect(first).rejects.toThrow('db down');
    await expect(second).rejects.toThrow('db down');

    // 失败不留缓存、不留探针：下一次调用重新查询并正常放行
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ pending: '1', oldest_pending_at: null }] satisfies InventoryRow[],
    });
    await expect(admission.assertCapacity()).resolves.toBeUndefined();
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});
