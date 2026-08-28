/** 死信列表（limit 钳位 1..200——复核面人工分页口径） */
import type { BillingStore, DeadCaseRow } from '../../../ports/billing-store.js';

export function listDead(
  env: { store: Pick<BillingStore, 'read' | 'listDeadCases'> },
  input: { limit: number; offset: number },
): Promise<{ rows: DeadCaseRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, input.limit));
  const offset = Math.max(0, input.offset);
  return env.store.read((conn) => env.store.listDeadCases(conn, { limit, offset }));
}
