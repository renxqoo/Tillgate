/**
 * 校准保留策略测试（docs §3.1——批后 best-effort 清理）：
 * 只清理触碰组；垃圾收据（缺 userId/mappingId）静默跳过；清理失败上抛由
 * 装配 catch（fire-and-forget 契约）。
 */
import { describe, expect, it } from 'vitest';
import { calibrationRetention } from '../src/calibration-retention';
import type { CalibrationStore } from '@tillgate/billing';

function recorder() {
  const calls: Array<{ userId: number; mappingId: number; keep: number }> = [];
  const store = {
    findRecent: async () => [],
    upsert: async () => {},
    cleanup: async (_conn: unknown, input: { userId: number; mappingId: number; keep: number }) => {
      calls.push(input);
      return 0;
    },
  } as unknown as CalibrationStore;
  return { calls, store };
}

describe('calibrationRetention（批后清理）', () => {
  it('合法收据 → 清理触碰组（keep=8 与读侧 recentLimit 对齐）', async () => {
    const { calls, store } = recorder();
    await calibrationRetention(store, { userId: 2, mappingId: 13 });
    expect(calls).toEqual([{ userId: 2, mappingId: 13, keep: 8 }]);
  });

  it('垃圾收据（缺字段/类型错）→ 静默跳过（不清理不抛）', async () => {
    const { calls, store } = recorder();
    await calibrationRetention(store, {});
    await calibrationRetention(store, { userId: 'x', mappingId: 13 });
    await calibrationRetention(store, { userId: 2, mappingId: null });
    expect(calls).toEqual([]);
  });

  it('清理失败上抛（装配 catch——fire-and-forget 面不重试）', async () => {
    const store = {
      findRecent: async () => [],
      upsert: async () => {},
      cleanup: async () => {
        throw new Error('db down');
      },
    } as unknown as CalibrationStore;
    await expect(calibrationRetention(store, { userId: 2, mappingId: 13 })).rejects.toThrow(
      'db down',
    );
  });
});
