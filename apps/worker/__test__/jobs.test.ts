/**
 * jobs 驱动规格（2026-08-26 BullMQ 增量改写）：结算 processor（定向认领→
 * processClaim→结局映射；未知异常不外抛=毒账单隔离）、直驱 job（due 扫描逐条）、
 * sweep（due 扫描入队；入队失败不致命）、对账（锁未获跳过/差异落表+告警/
 * 哨兵异常不算差异）、分区透传。用例本体（billing/inference/notifications
 * 包内）不在此重复。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import type { ClaimInput, ReconcileReport, SettlementClaim } from '@tillgate/billing';
import { createNotifyJob } from '../src/jobs/notify';
import { createPartitionJob } from '../src/jobs/partition';
import { createPollJob } from '../src/jobs/poll';
import { createReconcileJob } from '../src/jobs/reconcile';
import { createReferralJob } from '../src/jobs/referral';
import { createRecoveryJob } from '../src/jobs/recovery';
import { createSettlementDirectJob, createSettlementProcessor } from '../src/jobs/settlement';
import { createSettlementSweepJob } from '../src/jobs/settlement-sweep';

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

/** 记录定向认领入参的假 settlement 面 */
function settlementFace(claims: SettlementClaim[], overrides: Record<string, unknown> = {}) {
  const claimInputs: ClaimInput[] = [];
  return {
    claimInputs,
    face: {
      claim: async (input: ClaimInput) => {
        claimInputs.push(input);
        return claims.filter((c) => input.requestIds?.includes(c.requestId));
      },
      processClaim: async (_claim: SettlementClaim) => 'settled' as const,
      settleClaims: async () => [],
      listDueRequestIds: async () => claims.map((c) => c.requestId),
      ...overrides,
    },
  };
}

/** processor 构造助手（describe 外：不捕获作用域变量） */
function processorOf(face: unknown, errors: unknown[] = []) {
  return createSettlementProcessor({
    settlement: face as never,
    ownerId: 'w1',
    claimLeaseMs: 60_000,
    batchSize: 1,
    onError: (error) => errors.push(error),
  });
}

describe('jobs/settlement：单条 processor（毒账单隔离核心）', () => {
  it('定向认领：requestIds=[id]、batchSize=1；结局透传', async () => {
    const h = settlementFace([claimOf('r1')], {
      processClaim: async () => 'retried' as const,
    });
    const process = processorOf(h.face);
    expect(await process('r1')).toBe('retried');
    expect(defined(h.claimInputs[0], 'claim input')).toMatchObject({
      ownerId: 'w1',
      batchSize: 1,
      requestIds: ['r1'],
    });
  });

  it('空认领（已终态/他方持有）→ claim_lost 幂等完成，不触 processClaim', async () => {
    let processed = 0;
    const h = settlementFace([], {
      processClaim: async () => {
        processed += 1;
        return 'settled' as const;
      },
    });
    const process = processorOf(h.face);
    expect(await process('gone')).toBe('claim_lost');
    expect(processed).toBe(0);
  });

  it('未知异常不外抛 → unknown-failure（F-1：毒账单绝不杀进程）+ onError 记录', async () => {
    const errors: unknown[] = [];
    const h = settlementFace([claimOf('r1')], {
      processClaim: async () => {
        throw new Error('poison bill: usage insert FK violation');
      },
    });
    const process = processorOf(h.face, errors);
    expect(await process('r1')).toBe('unknown-failure');
    expect(errors).toHaveLength(1);
  });

  it('claim 自身抛错（DB 抖动）同样不外抛 → unknown-failure', async () => {
    const process = createSettlementProcessor({
      settlement: {
        claim: async () => {
          throw new Error('connection reset');
        },
        processClaim: async () => 'settled',
        settleClaims: async () => [],
      },
      ownerId: 'w1',
      claimLeaseMs: 60_000,
      batchSize: 1,
      onError: () => {},
    });
    expect(await process('r1')).toBe('unknown-failure');
  });
});

describe('jobs/settlement：直驱 job（runners.settle 确定性入口）', () => {
  it('due 扫描 → 逐条 processor → outcome 计数', async () => {
    const outcomeByRequest: Record<string, 'settled' | 'dead' | 'claim_lost'> = {
      r1: 'settled',
      r2: 'dead',
      r3: 'claim_lost',
    };
    const h = settlementFace([claimOf('r1'), claimOf('r2'), claimOf('r3')], {
      processClaim: async (claim: SettlementClaim) =>
        outcomeByRequest[claim.requestId] ?? 'settled',
    });
    const run = createSettlementDirectJob({
      settlement: h.face,
      ownerId: 'w1',
      claimLeaseMs: 60_000,
      batchSize: 10,
      onError: () => {},
    });
    expect(await run()).toEqual({
      due: 3,
      outcomes: { settled: 1, retried: 0, dead: 1, claim_lost: 1, 'unknown-failure': 0 },
    });
  });

  it('零 due 零副作用', async () => {
    const h = settlementFace([]);
    const run = createSettlementDirectJob({
      settlement: h.face,
      ownerId: 'w1',
      claimLeaseMs: 60_000,
      batchSize: 10,
      onError: () => {},
    });
    expect(await run()).toEqual({
      due: 0,
      outcomes: { settled: 0, retried: 0, dead: 0, claim_lost: 0, 'unknown-failure': 0 },
    });
  });
});

describe('jobs/settlement-sweep：due 扫描入队', () => {
  it('due 行批量入队（幂等入队语义在队列面）', async () => {
    const enqueued: string[][] = [];
    const run = createSettlementSweepJob({
      settlement: { listDueRequestIds: async () => ['r1', 'r2'] },
      enqueueMany: async (ids) => {
        enqueued.push([...ids]);
      },
      batchSize: 20,
      onError: () => {},
    });
    expect(await run()).toEqual({ due: 2, enqueued: true });
    expect(enqueued).toEqual([['r1', 'r2']]);
  });

  it('零 due 不入队；入队失败不致命（onError，PG 真相未动）', async () => {
    let zeroEnqueue = 0;
    const errors: unknown[] = [];
    const runZero = createSettlementSweepJob({
      settlement: { listDueRequestIds: async () => [] },
      enqueueMany: async () => {
        zeroEnqueue += 1;
      },
      batchSize: 20,
      onError: () => {},
    });
    await runZero();
    expect(zeroEnqueue).toBe(0);
    const runFail = createSettlementSweepJob({
      settlement: { listDueRequestIds: async () => ['r1'] },
      enqueueMany: async () => {
        throw new Error('redis down');
      },
      batchSize: 20,
      onError: (error) => errors.push(error),
    });
    await runFail();
    expect(errors).toHaveLength(1);
  });
});

describe('jobs/recovery：恢复 job', () => {
  it('recover 透传 batchSize', async () => {
    let received: { batchSize: number } | null = null;
    const run = createRecoveryJob({
      settlement: {
        recover: async (input) => {
          received = input;
          return { released: 2, claimsRequeued: 1 };
        },
      },
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

describe('jobs/settlement：批量捎带（吞吐收敛接线）', () => {
  function claimOfSeq(id: string): SettlementClaim {
    return { ...claimOf(id) } as SettlementClaim;
  }

  it('batchSize>1：捎带认领 due + settleClaims 批量，通知条结局透传且不落单条路径', async () => {
    const batches: unknown[][] = [];
    let singles = 0;
    const face = {
      claim: async (input: ClaimInput) =>
        input.requestIds ? [claimOf('r1')] : [claimOfSeq('r2'), claimOfSeq('r3')],
      settleClaims: async (claims: unknown[]) => {
        batches.push(claims);
        return claims.map(() => ({
          outcome: 'settled' as const,
          settled: true,
          amount: '1',
          waived: '0',
          channelCircuitBroken: false,
        }));
      },
      processClaim: async () => {
        singles += 1;
        return 'settled' as const;
      },
    };
    const process = createSettlementProcessor({
      settlement: face as never,
      ownerId: 'w1',
      claimLeaseMs: 60_000,
      batchSize: 3,
      onError: () => {},
    });
    expect(await process('r1')).toBe('settled');
    expect(batches).toHaveLength(1);
    expect(defined(batches[0])).toHaveLength(3); // 通知条 + 2 捎带
    expect(singles).toBe(0);
  });

  it('批内毒账单：整批回滚 → 回退逐张（通知条走 processClaim 语义）', async () => {
    const errors: unknown[] = [];
    let singles = 0;
    const face = {
      claim: async (input: ClaimInput) => (input.requestIds ? [claimOf('r1')] : [claimOfSeq('r2')]),
      settleClaims: async () => {
        throw new Error('poison in batch');
      },
      processClaim: async () => {
        singles += 1;
        return 'settled' as const;
      },
    };
    const process = createSettlementProcessor({
      settlement: face as never,
      ownerId: 'w1',
      claimLeaseMs: 60_000,
      batchSize: 2,
      onError: (error) => errors.push(error),
    });
    expect(await process('r1')).toBe('settled');
    expect(singles).toBeGreaterThanOrEqual(1); // 至少通知条回退单张
    expect(errors).toHaveLength(1);
  });

  it('batchSize=1：不捎带、不走批量路径', async () => {
    let batchCalled = 0;
    const face = {
      claim: async (input: ClaimInput) => (input.requestIds ? [claimOf('r1')] : []),
      settleClaims: async () => {
        batchCalled += 1;
        return [];
      },
      processClaim: async () => 'settled' as const,
    };
    const process = createSettlementProcessor({
      settlement: face as never,
      ownerId: 'w1',
      claimLeaseMs: 60_000,
      batchSize: 1,
      onError: () => {},
    });
    expect(await process('r1')).toBe('settled');
    expect(batchCalled).toBe(0);
  });
});
