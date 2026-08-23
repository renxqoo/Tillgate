/**
 * 对账差异落表用例（worker 消费）：ReconcileReport.violations →
 * reconcile_discrepancies 行。告警入箱不在此（billing 不拥有通知副作用——
 * worker 拿计数后经 notifications enqueue，fire-and-forget）。
 *
 * 数值口径挂账：v2 verifyInvariants 是复式不变量布尔核验（violation 无
 * expected/actual 数值），本用例记 '0' 并把完整上下文存 detail JSON；
 * 数值化差异（需要核验 SQL 输出两侧数值）是后续增强，届时表列已就位。
 */
import type { ReconcileDiscrepancyRow } from '../../ports/reconcile-store.js';
import type { ReconcileDiscrepancyStore } from '../../ports/reconcile-store.js';
import type { ReconcileReport } from './reconcile.js';

function scopeOf(kind: ReconcileReport['violations'][number]['kind']): string {
  if (kind === 'in_flight') return 'hold';
  // transaction_balance / account_balance：无用户归属维度（key = 交易/账户 id）
  return 'platform';
}

export function createRecordDiscrepanciesUseCase(env: { store: ReconcileDiscrepancyStore }) {
  return async function recordDiscrepancies(report: ReconcileReport): Promise<number> {
    if (report.violations.length === 0) return 0;
    const rows: ReconcileDiscrepancyRow[] = report.violations.map((violation) => ({
      scope: scopeOf(violation.kind),
      userId: null,
      expected: '0',
      actual: '0',
      diff: '0',
      detail: JSON.stringify({
        kind: violation.kind,
        key: violation.key,
        detail: violation.detail,
        checkedAt: report.checkedAt.toISOString(),
      }),
    }));
    return await env.store.insertDiscrepancies(rows);
  };
}
