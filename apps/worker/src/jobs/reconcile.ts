/**
 * 周期对账 job（v1 tasks/reconcile.ts 语义平移）：
 * 会话级 advisory try-lock（专用连接，锁键保留 v1——重叠部署互斥）→
 * verifyInvariants（只读哨兵）→ violations 落 reconcile_discrepancies 表
 * （billing 用例）+ 告警入箱（notifications enqueue，小时级 dedupe——
 * fire-and-forget，告警不反杀对账）。哨兵自身异常只 warn（不算差异，v1 同）。
 */
import type { ReconcileReport, SettlementApi } from '@tokenlens/billing';

interface ReconcileJobResult {
  /** null = 未获锁（他副本在跑——不误报不漏报）；false = 哨兵异常 */
  ran: boolean | null;
  violations: number;
  inserted: number;
  alerted: boolean;
}

type ReconcileJob = () => Promise<ReconcileJobResult>;

/** 会话级 try-lock 门（装配面注入：专用连接 + pg_try_advisory_lock） */
type AdvisoryTryLockGate = <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;

export function createReconcileJob(deps: {
  settlement: Pick<SettlementApi, 'verifyInvariants'>;
  lockKey: string;
  withTryLock: AdvisoryTryLockGate;
  recordDiscrepancies: (report: ReconcileReport) => Promise<number>;
  enqueueAlert: (input: { discrepancies: number; dedupeKey: string }) => Promise<void>;
  clock: () => Date;
  logger: { error(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}): ReconcileJob {
  return async function runReconcile(): Promise<ReconcileJobResult> {
    try {
      const outcome = await deps.withTryLock(deps.lockKey, async () => {
        const report = await deps.settlement.verifyInvariants();
        if (report.ok) {
          return { ran: true as const, violations: 0, inserted: 0, alerted: false };
        }
        const inserted = await deps.recordDiscrepancies(report);
        // 小时级去重（v1 dedupeKey 口径）：同一小时内的重复告警由唯一键吸收
        const hourKey = deps.clock().toISOString().slice(0, 13);
        let alerted = false;
        try {
          await deps.enqueueAlert({
            discrepancies: report.violations.length,
            dedupeKey: `reconcile-discrepancy:${hourKey}`,
          });
          alerted = true;
        } catch {
          // 告警入箱失败不反杀对账（差异表已落——真相在表）
        }
        return {
          ran: true as const,
          violations: report.violations.length,
          inserted,
          alerted,
        };
      });
      if (outcome == null) {
        return { ran: null, violations: 0, inserted: 0, alerted: false };
      }
      if (outcome.violations > 0) {
        deps.logger.error({ discrepancies: outcome.violations }, 'reconciliation discrepancies');
      }
      return outcome;
    } catch (error) {
      // 哨兵失败不算差异（v1 同口径）：记 warn，下一轮自愈
      deps.logger.warn({ err: String(error) }, 'reconcile failed');
      return { ran: false, violations: 0, inserted: 0, alerted: false };
    }
  };
}
