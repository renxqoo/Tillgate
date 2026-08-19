/**
 * billing/gates/admission：结算积压准入闸（S5 重写，自 authorize/admission.ts 平移）。
 * settlement_pending/processing/retry_wait 堆积过深或最老账单过老时关闭新请求——
 * 结算系统过载时的自我保护。短缓存 + 并发探针合并防准入查询本身打爆 DB。
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { BillingBacklogError } from '../../platform/errors.js';

export interface AdmissionGate {
  maxPending: number;
  maxOldestAgeMs: number;
  cacheMs: number;
}

export interface Admission {
  assertCapacity(): Promise<void>;
}

export function createAdmission(db: Db, config: AdmissionGate): Admission {
  let cache: { expiresAt: number; pending: number; oldestPendingMs: number } | undefined;
  let probe: Promise<{ pending: number; oldestPendingMs: number }> | undefined;
  return {
    async assertCapacity(): Promise<void> {
      const nowMs = Date.now();
      let state = cache && cache.expiresAt > nowMs ? cache : undefined;
      if (!state) {
        probe ??= db
          .execute<{ pending: string; oldest_pending_at: Date | string | null }>(sql`
            select
              count(*)::text as pending,
              min(created_at) as oldest_pending_at
            from billing_requests
            where status in ('settlement_pending','processing','retry_wait')
          `)
          .then((result) => {
            const row = result.rows[0];
            const oldestPendingMs = row?.oldest_pending_at
              ? Math.max(0, Date.now() - new Date(row.oldest_pending_at).getTime())
              : 0;
            const value = { pending: Number(row?.pending ?? 0), oldestPendingMs };
            cache = { ...value, expiresAt: Date.now() + config.cacheMs };
            return value;
          })
          .finally(() => {
            probe = undefined;
          });
        state = { ...(await probe), expiresAt: Date.now() + config.cacheMs };
      }
      if (state.pending >= config.maxPending || state.oldestPendingMs >= config.maxOldestAgeMs) {
        throw new BillingBacklogError(state.pending, state.oldestPendingMs);
      }
    },
  };
}
