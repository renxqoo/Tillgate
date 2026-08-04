import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@ai-gateway/db';
import { syncSettle, type SyncSettleData } from './sync-settle.js';

/**
 * 同步降级结算（资损防线）：
 *   meter 入队失败（Redis 挂）时，gateway 不能漏扣——
 *   直接在请求路径内同步结算（DB 原子扣费），作为 BullMQ 不可用时的兜底。
 *
 * 幂等：与 worker settle 共享 usage_logs.request_id 唯一约束 + transactions 部分唯一索引。
 * → Redis 恢复后 worker 收到同一 job 也会跳过（已结算），不重复扣费。
 */

const MOCK_DATA: SyncSettleData = {
  requestId: '11111111-1111-1111-1111-111111111111',
  userId: 1,
  apiKeyId: null,
  appId: null,
  credentialType: 'key',
  externalModel: 'test-model',
  realModel: 'test-real',
  channelId: null,
  usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
  inputPrice: 1_000_000,
  outputPrice: 2_000_000,
  cacheInputPrice: 100_000,
  coefficient: 1.0,
  coefficientMilli: 1000,
  durationMs: 100,
  stream: false,
  streamAborted: false,
  holdAmount: 0,
  mappingId: 1,
};

/** mock db.transaction：模拟 drizzle 链式调用（values → onConflictDoNothing → returning） */
const mockReturning = (settled: boolean) => vi.fn().mockResolvedValue(settled ? [{ id: 1 }] : []);
const mockConflict = (settled: boolean) => vi.fn().mockReturnValue({ returning: mockReturning(settled) });
const mockValues = (settled: boolean) => vi.fn().mockReturnValue({ onConflictDoNothing: mockConflict(settled) });
const mockUpdateReturning = () => vi.fn().mockResolvedValue([{ balance: 99998000 }]);
const mockUpdateWhere = () => vi.fn().mockReturnValue({ returning: mockUpdateReturning() });
const mockUpdateSet = () => vi.fn().mockReturnValue({ where: mockUpdateWhere() });
const mockTxUpdate = () => vi.fn().mockReturnValue({ set: mockUpdateSet() });

function makeMockDb(settled: boolean = true) {
  const tx = {
    insert: vi.fn().mockReturnValue({ values: mockValues(settled) }),
    update: mockTxUpdate(),
  };
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

describe('syncSettle（meter 入队失败时的同步降级结算）', () => {
  it('首次结算 → 成功扣费', async () => {
    const db = makeMockDb(true);
    const result = await syncSettle(db, MOCK_DATA);
    expect(result.settled).toBe(true);
    expect(result.amount).toBeGreaterThan(0);
  });

  it('重复结算（已结算）→ 幂等跳过（settled=false）', async () => {
    const db = makeMockDb(false); // returning 空 = 已存在
    const result = await syncSettle(db, MOCK_DATA);
    expect(result.settled).toBe(false);
  });

  it('DB 异常 → 抛错（调用方据此记日志，绝不静默漏扣）', async () => {
    const db = {
      transaction: vi.fn(async () => {
        throw new Error('DB connection lost');
      }),
    } as unknown as Db;
    await expect(syncSettle(db, MOCK_DATA)).rejects.toThrow('DB connection lost');
  });

  it('零用量 → amount=0，仍写 usage_logs（审计记录）', async () => {
    const db = makeMockDb(true);
    const result = await syncSettle(db, { ...MOCK_DATA, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false } });
    expect(result.amount).toBe(0);
    expect(result.settled).toBe(true);
  });
});
