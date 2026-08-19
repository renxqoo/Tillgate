/**
 * 开账迁移 CLI（S8，停机窗口执行）：
 *   npx tsx packages/ledger/scripts/migrate-opening.ts [--dry-run]
 * 全量相等性门禁失败即非零退出（不切流）。
 */
import { createDb } from '@ai-gateway/db';
import { createWallet } from '@ai-gateway/wallet';
import { runOpeningMigration, listUsersWithLegacyBalance, activeBillingCount } from '../src/migration/opening.js';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');
const wallet = createWallet(db, {
  accounts: [],
  refTypes: ['admin', 'billing'],
  currencies: ['CNY'],
});

const dryRun = process.argv.includes('--dry-run');
const legacyUsers = await listUsersWithLegacyBalance(db);
const activeBilling = await activeBillingCount(db);
console.log(`[opening] legacy-balance users: ${legacyUsers.length}, active billing requests: ${activeBilling}`);

if (!dryRun) {
  const report = await runOpeningMigration(db, wallet);
  console.log(
    `[opening] users=${report.usersChecked} credits=${report.credits} creditLines=${report.creditLines} authorizations=${report.authorizationsRebuilt}`,
  );
  if (report.equalities.length > 0) {
    console.error(`[opening] EQUALITY GATE FAILED (${report.equalities.length} users):`);
    for (const e of report.equalities.slice(0, 20)) console.error(e);
    process.exit(1);
  }
  console.log('[opening] equality gate passed: wallet balances == users.balance for all users');
}
await db.$client.end();
