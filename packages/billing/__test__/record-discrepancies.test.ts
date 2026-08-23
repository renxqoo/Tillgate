/**
 * 对账差异落表用例单测（stub store——postgres insert 由 real 门覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { createRecordDiscrepanciesUseCase } from '../src/application/settlement/record-discrepancies.js';
import type { ReconcileDiscrepancyRow } from '../src/ports/reconcile-store.js';
import type { ReconcileReport } from '../src/application/settlement/reconcile.js';

function harness() {
  const inserted: ReconcileDiscrepancyRow[][] = [];
  const record = createRecordDiscrepanciesUseCase({
    store: {
      async insertDiscrepancies(rows) {
        inserted.push([...rows]);
        return rows.length;
      },
    },
  });
  return { record, inserted };
}

const report = (violations: ReconcileReport['violations']): ReconcileReport => ({
  ok: violations.length === 0,
  checkedAt: new Date('2026-08-23T01:00:00Z'),
  violations,
});

describe('对账差异落表（record-discrepancies）', () => {
  it('ok 报告：零写入', async () => {
    const h = harness();
    expect(await h.record(report([]))).toBe(0);
    expect(h.inserted).toHaveLength(0);
  });

  it('三类漂移 → scope 映射（in_flight=hold，其余 platform）+ detail JSON 全上下文', async () => {
    const h = harness();
    const count = await h.record(
      report([
        { kind: 'transaction_balance', key: 'tx-1', detail: 'legs sum 5 kind credit' },
        { kind: 'account_balance', key: 'acct-9', detail: 'balance 3 last leg 2' },
        { kind: 'in_flight', key: 'acct-9', detail: 'in_flight 1 active sum 0' },
      ]),
    );
    expect(count).toBe(3);
    const rows = h.inserted[0]!;
    expect(rows.map((r) => r.scope)).toEqual(['platform', 'platform', 'hold']);
    for (const row of rows) {
      expect(row.userId).toBeNull();
      // 数值口径挂账：布尔核验无数值——三列记 '0'，真相在 detail
      expect([row.expected, row.actual, row.diff]).toEqual(['0', '0', '0']);
    }
    const first = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(first).toMatchObject({ kind: 'transaction_balance', key: 'tx-1' });
    expect(first.checkedAt).toBe('2026-08-23T01:00:00.000Z');
  });
});
