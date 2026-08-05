import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '@ai-gateway/money';
import type { Db } from '@ai-gateway/db';
import { syncSettle, type SyncSettleData } from './sync-settle.js';

/**
 * 同步降级结算（资损防线）：
 *   meter 入队失败（Redis 挂）时，gateway 不能漏扣——
 *   直接在请求路径内同步结算（DB 原子扣费），作为 BullMQ 不可用时的兜底。
 *
 * 幂等：与 worker settle 共享 usage_logs.request_id 唯一约束 + transactions 部分唯一索引。
 * → Redis 恢复后 worker 收到同一 job 也会跳过（已结算），不重复扣费。
 *
 * C1 修复后行为：透支=坏账（status=2），不扣余额、不写 consume 流水。
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
  inputPrice: '1',
  outputPrice: '2',
  cacheInputPrice: '0.1',
  coefficient: '1.0',
  durationMs: 100,
  stream: false,
  streamAborted: false,
  holdAmount: '0',
  mappingId: 1,
};

/** mock insert 链：values → onConflictDoNothing → returning */
function makeInsertChain(returning: unknown[]) {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  });
}

/** mock update 链：set → where → returning（命中返回新余额） */
function makeUpdateChain(returning: unknown[]) {
  return vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  });
}

/**
 * 构造 mock 事务。
 * @param insertReturning usage_logs INSERT returning（[] = 已结算幂等跳过）
 * @param updateReturning users UPDATE returning（扣费后余额；负数 = 透支欠款）
 */
function makeTx(opts: {
  insertReturning?: unknown[];
  updateReturning?: unknown[];
}) {
  return {
    insert: makeInsertChain(opts.insertReturning ?? [{ id: 1 }]),
    update: makeUpdateChain(opts.updateReturning ?? [{ balance: 99998000 }]),
  };
}

function makeDb(tx: unknown): Db {
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

describe('syncSettle（meter 入队失败时的同步降级结算，元 + decimal）', () => {
  it('首次结算 → 成功扣费', async () => {
    const tx = makeTx({ insertReturning: [{ id: 1 }] });
    const result = await syncSettle(makeDb(tx), MOCK_DATA);
    expect(result.settled).toBe(true);
    // amount = (1000×1 + 500×2)/1e6 = 0.002 元（非 0）
    expect(new Decimal(result.amount).gt(0)).toBe(true);
    expect(result.overdraft).toBe(false);
  });

  it('重复结算（已结算）→ 幂等跳过（settled=false）', async () => {
    const tx = makeTx({ insertReturning: [] }); // returning 空 = 已存在
    const result = await syncSettle(makeDb(tx), MOCK_DATA);
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
    const tx = makeTx({ insertReturning: [{ id: 1 }] });
    const result = await syncSettle(makeDb(tx), {
      ...MOCK_DATA,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    });
    expect(new Decimal(result.amount).isZero()).toBe(true);
    expect(result.settled).toBe(true);
  });

  // ---- 透支：允许负余额模型（如实扣全额，余额可为负 = 欠款）----
  it('透支：余额 < amount → 如实扣全额，update 返回负数余额，overdraft=true', async () => {
    // 余额 0.001，amount 0.002 → update 返回 -0.001（透支欠款）
    const tx = makeTx({ insertReturning: [{ id: 1 }], updateReturning: [{ balance: '-0.001' }] });
    const result = await syncSettle(makeDb(tx), MOCK_DATA);
    expect(result.settled).toBe(true);
    expect(result.overdraft).toBe(true); // 余额为负 → 透支标记
    expect(new Decimal(result.amount).equals(new Decimal('0.002'))).toBe(true); // 真实费用如实记录
    // 写 2 条 insert（usage_logs + consume 流水）—— 透支也如实写流水
    expect(tx.insert).toHaveBeenCalledTimes(2);
  });

  it('正常计费：update 返回非负余额 → overdraft=false', async () => {
    const tx = makeTx({ insertReturning: [{ id: 1 }], updateReturning: [{ balance: '99.998' }] });
    const result = await syncSettle(makeDb(tx), MOCK_DATA);
    expect(result.settled).toBe(true);
    expect(result.overdraft).toBe(false);
  });
});
