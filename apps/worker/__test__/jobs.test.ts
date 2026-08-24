/**
 * jobs 驱动规格：结算批次（认领→保活→processClaim→计数；零认领早退）、
 * 对账（锁未获跳过/差异落表+告警/哨兵异常不算差异）、分区透传。
 * 用例本体（billing/inference/notifications 包内）不在此重复。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReconcileReport, SettlementApi, SettlementClaim } from '@tillgate/billing';
import { createNotifyJob } from '../src/jobs/notify';
import { createPartitionJob } from '../src/jobs/partition';
import { createPollJob } from '../src/jobs/poll';
import { createReconcileJob } from '../src/jobs/reconcile';
import { createReferralJob } from '../src/jobs/referral';
import { createRecoveryJob, createSettlementBatchJob } from '../src/jobs/settlement';

function claimOf(requestId: string): SettlementClaim {
  return {
    requestId,
    ownerId: 'w1',
    claimToken: `tok-${requestId}`,
    revision: 1,
    attempt: 1,
    receipt: null,
    traceParent: null,
  };
}

describe('jobs/settlement：结算批次', () => {
  it('零认领早退（零副作用）', async () => {
    let renewCalls = 0;
    const run = createSettlementBatchJob({
      settlement: {
        claim: async () => [],
        renewClaims: async () => {
          renewCalls += 1;
        },
        processClaim: async () => 'settled',
      },
      ownerId: 'w1',
      batchSize: 10,
      claimLeaseMs: 60_000,
    });
    expect(await run()).toEqual({ claimed: 0, settled: 0, retried: 0, dead: 0, claimLost: 0 });
    expect(renewCalls).toBe(0);
  });

  it('批次闭环：认领 N → processClaim 并行 → outcome 计数', async () => {
    const processed: string[] = [];
    const run = createSettlementBatchJob({
      settlement: {
        claim: async () => [claimOf('r1'), claimOf('r2'), claimOf('r3'), claimOf('r4')],
        renewClaims: async () => undefined,
        processClaim: async (claim) => {
          processed.push(claim.requestId);
          if (claim.requestId === 'r1') return 'settled';
          if (claim.requestId === 'r2') return 'retried';
          if (claim.requestId === 'r3') return 'dead';
          return 'claim_lost';
        },
      },
      ownerId: 'w1',
      batchSize: 10,
      claimLeaseMs: 60_000,
    });
    expect(await run()).toEqual({ claimed: 4, settled: 1, retried: 1, dead: 1, claimLost: 1 });
    expect(processed.toSorted()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('恢复 job：recover 透传 batchSize', async () => {
    let received: { batchSize: number } | null = null;
    const run = createRecoveryJob({
      settlement: {
        recover: async (input) => {
          received = input;
          return { released: 2, claimsRequeued: 1 };
        },
      } as Pick<SettlementApi, 'recover'>,
      batchSize: 50,
    });
    expect(await run()).toEqual({ released: 2, claimsRequeued: 1 });
    expect(received).toEqual({ batchSize: 50 });
  });
});

const report = (violations: ReconcileReport['violations']): ReconcileReport => ({
  ok: violations.length === 0,
  checkedAt: new Date('2026-08-23T01:00:00Z'),
  violations,
});

describe('jobs/reconcile：周期对账哨兵', () => {
  function harness(options?: {
    lockGranted?: boolean;
    violations?: ReconcileReport['violations'];
    recordFails?: boolean;
    verifyThrows?: boolean;
  }) {
    const alerts: Array<{ discrepancies: number; dedupeKey: string }> = [];
    const recorded: ReconcileReport[] = [];
    const errors: Array<{ obj: unknown; msg: string }> = [];
    const warns: Array<{ obj: unknown; msg: string }> = [];
    const run = createReconcileJob({
      settlement: {
        verifyInvariants: async () => {
          if (options?.verifyThrows) throw new Error('sentinel down');
          return report(options?.violations ?? []);
        },
      },
      lockKey: 'k',
      withTryLock: async (_key, fn) => (options?.lockGranted === false ? null : await fn()),
      recordDiscrepancies: async (r) => {
        recorded.push(r);
        if (options?.recordFails) throw new Error('insert failed');
        return r.violations.length;
      },
      enqueueAlert: async (input) => {
        alerts.push(input);
      },
      clock: () => new Date('2026-08-23T07:30:00Z'),
      logger: {
        error: (obj, msg) => errors.push({ obj, msg }),
        warn: (obj, msg) => warns.push({ obj, msg }),
      },
    });
    return { run, alerts, recorded, errors, warns };
  }

  it('净账本零违规：零差异零告警', async () => {
    const h = harness();
    expect(await h.run()).toEqual({ ran: true, violations: 0, inserted: 0, alerted: false });
    expect(h.alerts).toHaveLength(0);
  });

  it('违规 → 差异落表 + 告警入箱（小时级 dedupeKey）+ error 日志', async () => {
    const h = harness({
      violations: [
        { kind: 'account_balance', key: 'a-1', detail: 'balance drift' },
        { kind: 'in_flight', key: 'a-1', detail: 'in_flight drift' },
      ],
    });
    expect(await h.run()).toEqual({ ran: true, violations: 2, inserted: 2, alerted: true });
    expect(h.alerts).toEqual([
      { discrepancies: 2, dedupeKey: 'reconcile-discrepancy:2026-08-23T07' },
    ]);
    expect(h.errors).toHaveLength(1);
  });

  it('锁未获（他副本在跑）→ ran=null 零副作用', async () => {
    const h = harness({ lockGranted: false });
    expect(await h.run()).toEqual({ ran: null, violations: 0, inserted: 0, alerted: false });
    expect(h.recorded).toHaveLength(0);
  });

  it('差异落表失败 → 整轮算哨兵异常（ran=false，不算差异——v1 口径）', async () => {
    const h = harness({
      violations: [{ kind: 'in_flight', key: 'a', detail: 'x' }],
      recordFails: true,
    });
    expect(await h.run()).toEqual({ ran: false, violations: 0, inserted: 0, alerted: false });
    expect(h.warns).toHaveLength(1);
    expect(h.alerts).toHaveLength(0);
  });

  it('哨兵自身异常 → warn 不算差异', async () => {
    const h = harness({ verifyThrows: true });
    expect(await h.run()).toEqual({ ran: false, violations: 0, inserted: 0, alerted: false });
    expect(h.warns).toHaveLength(1);
  });
});

describe('jobs/partition：分区维护', () => {
  it('两个 facade 透传 + 结果汇总（有动作才记日志）', async () => {
    const logs: Array<{ obj: unknown; msg: string }> = [];
    const calls: string[] = [];
    const run = createPartitionJob({
      partitions: {
        traces: async (options) => {
          calls.push(`traces:${JSON.stringify(options)}`);
          return { created: ['trace_spans_20260824'], dropped: [] };
        },
        requestLogs: async (options) => {
          calls.push(`requestLogs:${JSON.stringify(options)}`);
          return { created: [], dropped: ['request_logs_2025_07'] };
        },
      },
      traceRetentionDays: 7,
      requestLogRetentionDays: 90,
      logger: { info: (obj, msg) => logs.push({ obj, msg }) },
    });
    const result = await run();
    expect(result.traces.created).toEqual(['trace_spans_20260824']);
    expect(result.requestLogs.dropped).toEqual(['request_logs_2025_07']);
    expect(calls).toEqual(['traces:{"retentionDays":7}', 'requestLogs:{"retentionDays":90}']);
    expect(logs).toHaveLength(2);
  });

  it('零动作零日志', async () => {
    const logs: unknown[] = [];
    const run = createPartitionJob({
      partitions: {
        traces: async () => ({ created: [], dropped: [] }),
        requestLogs: async () => ({ created: [], dropped: [] }),
      },
      traceRetentionDays: 7,
      requestLogRetentionDays: 90,
      logger: { info: (_obj, _msg) => void logs.push(1) },
    });
    await run();
    expect(logs).toHaveLength(0);
  });
});

describe('jobs 驱动壳透传（notify/poll/referral）', () => {
  it('notify：dispatchOnce 结果直通', async () => {
    const run = createNotifyJob({
      dispatchOnce: async () => ({ sent: 2, failed: 1 }),
    });
    expect(await run()).toEqual({ sent: 2, failed: 1 });
  });

  it('poll：generation-poll 结果直通', async () => {
    const run = createPollJob({
      poll: async () => ({ expired: 1, polled: 2, executed: 0, succeeded: 1, failed: 1 }),
    });
    expect(await run()).toEqual({ expired: 1, polled: 2, executed: 0, succeeded: 1, failed: 1 });
  });

  it('referral：佣金结果直通', async () => {
    const run = createReferralJob({
      run: async () => ({ credited: 4 }),
    });
    expect(await run()).toEqual({ credited: 4 });
  });
});

describe('jobs/settlement：租约保活定时器', () => {
  it('批次运行期间按 claimLeaseMs/3 续租（失败不杀批次）', async () => {
    vi.useFakeTimers();
    try {
      const renewed: Array<{ tokens: string[]; claimLeaseMs: number }> = [];
      let releaseBatch!: () => void;
      const batchGate = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      const run = createSettlementBatchJob({
        settlement: {
          claim: async () => [claimOf('r1'), claimOf('r2')],
          renewClaims: async (input) => {
            renewed.push({ tokens: [...input.tokens], claimLeaseMs: input.claimLeaseMs });
            if (renewed.length === 1) throw new Error('renew down'); // 失败不杀批次
          },
          processClaim: async () => {
            await batchGate;
            return 'settled';
          },
        },
        ownerId: 'w1',
        batchSize: 10,
        claimLeaseMs: 3_000, // 续租节奏 = max(1000, 1000) = 1000
      });
      const pending = run();
      await vi.advanceTimersByTimeAsync(1_000); // 首次续租（抛错被吞）
      await vi.advanceTimersByTimeAsync(1_000); // 第二次续租成功
      releaseBatch();
      const result = await pending;
      expect(result).toMatchObject({ claimed: 2, settled: 2 });
      expect(renewed.length).toBe(2);
      expect(renewed[0]!.tokens).toEqual(['tok-r1', 'tok-r2']);
    } finally {
      vi.useRealTimers();
    }
  });
});
