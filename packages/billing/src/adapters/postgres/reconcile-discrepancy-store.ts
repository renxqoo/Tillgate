/**
 * ReconcileDiscrepancyStore 生产适配器（reconcile_discrepancies 批量 insert）。
 */
import type { Db } from '@tokenlens/db';
import { reconcileDiscrepancies } from '@tokenlens/db';
import type { ReconcileDiscrepancyStore } from '../../ports/reconcile-store.js';

export function createPostgresReconcileDiscrepancyStore(db: Db): ReconcileDiscrepancyStore {
  return {
    async insertDiscrepancies(rows): Promise<number> {
      if (rows.length === 0) return 0;
      await db.insert(reconcileDiscrepancies).values([...rows]);
      return rows.length;
    },
  };
}
