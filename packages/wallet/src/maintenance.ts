/** 运维入口：公平过期扫描与只读全账本核验；和业务 Facade/迁移权限分离。 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { releaseExpired } from './release';
import { InvalidInputError } from './errors';
import type { WalletTelemetry } from './types';

export interface WalletInvariantViolation {
  type: 'transaction_balance' | 'account_balance' | 'in_flight';
  entityId: string;
  expected: string;
  actual: string;
}

export interface WalletInvariantReport {
  ok: boolean;
  checkedAt: string;
  violations: WalletInvariantViolation[];
}

export interface WalletMaintenance {
  releaseExpired(limit?: number): Promise<{ released: number }>;
  verifyInvariants(limit?: number): Promise<WalletInvariantReport>;
}

export function createWalletMaintenance(
  db: NodePgDatabase,
  options: { telemetry?: WalletTelemetry } = {},
): WalletMaintenance {
  return {
    releaseExpired: (limit) => releaseExpired(db, limit, options.telemetry),
    async verifyInvariants(limit = 1000) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new InvalidInputError('limit', 'must be an integer between 1 and 10000');
      }
      const result = await db.execute(sql`
        with transaction_drift as (
          select 'transaction_balance'::text as type, t.id::text as entity_id,
                 'balanced legs'::text as expected,
                 ('count=' || count(l.id)::text || ',sum=' || coalesce(sum(l.amount), 0)::text) as actual
          from wallet_transactions t
          left join wallet_legs l on l.transaction_id = t.id
          group by t.id, t.kind
          having coalesce(sum(l.amount), 0) <> 0
             or (t.kind in ('credit_line', 'freeze') and count(l.id) <> 1)
             or (t.kind not in ('credit_line', 'freeze') and count(l.id) < 2)
        ), account_snapshot as (
          select a.id, a.balance, a.in_flight,
                 coalesce(last_leg.balance_after, 0) as derived_balance,
                 coalesce(active.total, 0) as derived_in_flight
          from wallet_accounts a
          left join lateral (
            select l.balance_after from wallet_legs l
            where l.account_id = a.id order by l.id desc limit 1
          ) last_leg on true
          left join lateral (
            select sum(wa.amount) as total from wallet_authorizations wa
            where wa.account_id = a.id and wa.status = 'active'
          ) active on true
        ), account_drift as (
          select 'account_balance'::text as type, id::text as entity_id,
                 derived_balance::text as expected, balance::text as actual
          from account_snapshot where balance <> derived_balance
          union all
          select 'in_flight', id::text, derived_in_flight::text, in_flight::text
          from account_snapshot where in_flight <> derived_in_flight
        )
        select * from transaction_drift
        union all
        select * from account_drift
        limit ${limit}
      `);
      const violations = result.rows.map((row) => ({
        type: String(row.type) as WalletInvariantViolation['type'],
        entityId: String(row.entity_id),
        expected: String(row.expected),
        actual: String(row.actual),
      }));
      return {
        ok: violations.length === 0,
        checkedAt: new Date().toISOString(),
        violations,
      };
    },
  };
}
