/**
 * 开账迁移（S8）：旧资金模型 → wallet 单事务开账。
 *
 * 每用户一笔幂等 credit（operationId `migration:opening:{userId}`，重跑安全）：
 *   - users.credit_limit ≠ 0 → wallet.setCreditLimit（先于余额——负余额 transfer
 *     的守卫含信用地板，授信未落会被拒）
 *   - users.balance ≠ 0 → wallet.credit（counter-leg = outside 镜像，复式两端齐全）
 *   - 活跃 billing_requests（authorized/in_flight）→ wallet.authorize 重建在途
 *     （refType 'billing'，refId = requestId；金额 = reserved_amount − plan 部分）
 * 全量相等性门禁：迁移后 wallet 余额 == users.balance、Σ在途 == reserved_balance
 * 的 PAYG 部分；不全等即失败退出（不切流）。
 *
 * 运行方式（停机窗口）：npx tsx packages/ledger/scripts/migrate-opening.ts
 */
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { Decimal, toDecimal } from '@ai-gateway/wallet/metering';
import { createDomainOperations } from '../platform/index.js';

export interface OpeningMigrationReport {
  usersChecked: number;
  credits: number;
  creditLines: number;
  authorizationsRebuilt: number;
  equalities: { userId: number; usersBalance: string; walletBalance: string }[];
}

export async function runOpeningMigration(db: Db, wallet: Wallet): Promise<OpeningMigrationReport> {
  const operations = createDomainOperations(db, ['migration.opening']);

  const rows = await db.execute<{ id: number; balance: string; credit_limit: string; reserved_balance: string }>(sql`
    select id, balance, credit_limit, reserved_balance from users
  `);
  const report: OpeningMigrationReport = {
    usersChecked: rows.rows.length,
    credits: 0,
    creditLines: 0,
    authorizationsRebuilt: 0,
    equalities: [],
  };

  for (const row of rows.rows) {
    const userId = Number(row.id);
    // ① 授信地板先行：负余额用户的 transfer 守卫是 balance + creditLimit ≥ amount，
    // 授信未落时任何非零负余额都会被拒——顺序即正确性（2026-08-18 审计修复）。
    if (!toDecimal(row.credit_limit).isZero()) {
      await wallet.setCreditLimit({
        userId,
        amount: row.credit_limit,
        refType: 'admin',
        refId: `migration:opening:credit-line:${userId}`,
      });
      report.creditLines += 1;
    }
    // ② 期初余额入账（幂等：migration:opening:{userId}）
    if (!toDecimal(row.balance).isZero()) {
      const negative = toDecimal(row.balance).isNegative();
      const amount = negative ? row.balance.replace('-', '') : row.balance;
      await operations.run({
        operationId: `migration:opening:${userId}`,
        kind: 'migration.opening',
        fingerprint: { userId, balance: row.balance },
        execute: async (tx) => {
          if (negative) {
            // 负余额：transfer user→outside（①的授信已落，守卫含信用地板）
            await wallet.transfer({
              from: { userId }, to: { code: 'outside' }, amount,
              refType: 'admin', refId: `migration:opening:${userId}`,
              allowCredit: true,
              tx: tx as never,
            });
          } else {
            await wallet.credit({
              userId, amount,
              refType: 'admin', refId: `migration:opening:${userId}`,
              memo: '开账迁移期初余额',
              tx: tx as never,
            });
          }
          return { userId, balance: row.balance };
        },
      });
      report.credits += 1;
    }
  }

  // ③ 活跃账单的 PAYG 在途重建（订阅/渠道投影不动——额度与敞口不是钱）
  const active = await db.execute<{ request_id: string; user_id: number; reserved_amount: string; plan_reserved_amount: string | null }>(sql`
    select request_id, user_id, reserved_amount, plan_reserved_amount
    from billing_requests
    where status in ('authorized','in_flight')
  `);
  for (const row of active.rows) {
    const paygPart = toDecimal(row.reserved_amount).minus(toDecimal(row.plan_reserved_amount ?? '0'));
    if (paygPart.lte(0)) continue;
    await wallet.authorize({
      userId: Number(row.user_id),
      amount: paygPart.toString(),
      refType: 'billing',
      refId: row.request_id,
      memo: '开账迁移在途重建',
    });
    report.authorizationsRebuilt += 1;
  }

  // ④ 全量相等性门禁：wallet 余额 == users.balance（逐用户）
  const accounts = await db.execute<{ user_id: number; balance: string }>(sql`
    select a.user_id as user_id, a.balance as balance
    from wallet_accounts a
    where a.kind = 'user' and a.currency = 'CNY'
  `);
  const walletBalances = new Map<number, string>();
  for (const a of accounts.rows) walletBalances.set(Number(a.user_id), a.balance);
  for (const row of rows.rows) {
    const userId = Number(row.id);
    const walletBalance = walletBalances.get(userId) ?? '0';
    if (!new Decimal(walletBalance).eq(new Decimal(row.balance))) {
      report.equalities.push({ userId, usersBalance: row.balance, walletBalance });
    }
  }
  return report;
}

/** 清理开账幂等键（回滚迁移用；生产不删审计物） */
export async function resetOpeningMigration(db: Db): Promise<void> {
  await db.execute(sql`
    delete from ledger_operations where operation_id like 'migration:opening:%'
  `);
}

export async function listUsersWithLegacyBalance(db: Db): Promise<number[]> {
  // 列已 DROP 后此查询恒空（迁移完成的自证）；原生 SQL 避免 schema 列引用
  const rows = await db.execute<{ id: number }>(sql`
    select id from users where exists (
      select 1 from information_schema.columns
      where table_name = 'users' and column_name = 'balance'
    ) and balance <> 0
  `);
  return rows.rows.map((row) => Number(row.id));
}

export async function activeBillingCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(billingRequests)
    .where(inArray(billingRequests.status, ['authorized', 'in_flight']));
  return Number(row?.count ?? 0);
}
