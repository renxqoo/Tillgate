import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';

import { reconcileUser, reconcileUsageVsTransactions, reconcileSubscriptionReserved } from './user.js';
import { reconcileChannels } from './channel.js';

/** 对账结果（checkedChannels 可选：用户级单查时不涉及渠道） */
export interface ReconcileResult {
  checkedUsers: number;
  checkedChannels?: number;
  discrepancies: number;
}

export { reconcileUser, reconcileUsageVsTransactions, reconcileSubscriptionReserved } from './user.js';
export { reconcileChannelReserved, reconcileChannels } from './channel.js';

/** 全量对账编排（拆自 reconcile.ts，行为零变更）。 */
/**
 * 全量对账：扫描近期有交易的用户，逐个校验。
 * @param recentDays 只查最近 N 天有交易的用户（避免全表扫描）
 */
export async function reconcileAll(db: Db, recentDays = 7): Promise<ReconcileResult> {
  const recentUsers = await db.execute<{ user_id: number }>(sql`
    select user_id from transactions
      where created_at >= now() - (${recentDays}::text || ' days')::interval
    union
    select user_id from billing_requests
      where created_at >= now() - (${recentDays}::text || ' days')::interval
  `);
  let discrepancies = 0;
  for (const row of recentUsers.rows) {
    const userId = Number(row.user_id);
    const [balanceOk, usageOk, subscriptionOk] = await Promise.all([
      reconcileUser(db, userId),
      reconcileUsageVsTransactions(db, userId),
      reconcileSubscriptionReserved(db, userId),
    ]);
    if (!balanceOk) discrepancies += 1;
    if (!usageOk) discrepancies += 1;
    if (!subscriptionOk) discrepancies += 1;
  }
  const channelsResult = await reconcileChannels(db, recentDays);
  return {
    checkedUsers: recentUsers.rows.length,
    checkedChannels: channelsResult.checkedChannels,
    discrepancies: discrepancies + channelsResult.discrepancies,
  };
}
