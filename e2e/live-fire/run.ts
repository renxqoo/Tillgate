/**
 * live-fire 主编排:起栈 → 种子(渠道目录/管理员/测试用户) → 跑全部用例 → 清理 → 报告。
 * 用法: bun e2e/live-fire/run.ts [--only=id1,id2] [--no-cleanup] [--keep-stack]
 */
import { loadRootEnv, runAll, report } from './lib/h.ts';
import { URLS, startStack, stopStack } from './lib/stack.ts';
import {
  seedCatalog,
  adminLogin,
  swapSmtpToSink,
  restoreSmtp,
  cleanup,
  mkUser,
  mkKey,
  fund,
  wallet,
  billOf,
  usageRow,
  usageSum,
  billCount,
} from './lib/seed.ts';

// 用例注册(导入顺序 = 执行顺序)
import './cases-smoke.ts';
import './cases-billing.ts';
import './cases-fault.ts';
import './cases-gwauth.ts';
import './cases-clientauth.ts';
import './cases-conc.ts';
import './cases-p1.ts';

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const noCleanup = args.includes('--no-cleanup');
const keepStack = args.includes('--keep-stack');

loadRootEnv();
const ctx: any = { url: URLS, seed: { mkUser, mkKey, fund, wallet, billOf, usageRow, usageSum, billCount } };

let failedToBoot = false;
try {
  console.log('[run] starting stack…');
  await startStack();
  console.log('[run] seeding catalog + admin…');
  const seeded = await seedCatalog();
  ctx.db = seeded.db;
  // 引导测试管理员(create-admin 真实路径,幂等:已存在则报错忽略)
  const out = Bun.spawnSync([
    'bun', 'scripts/create-admin.ts',
    '--email=rt-admin@fire.test', '--password=Rt!AdminPass#7', '--role=super_admin', '--apply',
  ], { cwd: 'apps/admin-api', env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const adminLog = out.stdout.toString() + out.stderr.toString();
  if (!/already exists|已存在|created|成功|apply/i.test(adminLog)) {
    console.log(`[run] create-admin output: ${adminLog.slice(0, 400)}`);
  }
  ctx.adminToken = await adminLogin();
  await swapSmtpToSink();
  console.log('[run] stack ready, running cases…');
} catch (error) {
  failedToBoot = true;
  console.error('[run] BOOT FAILED:', error instanceof Error ? error.stack : error);
}

let summary = { pass: 0, fail: 0, skip: 0, total: 0 };
if (!failedToBoot) {
  const results = await runAll(ctx, only);
  summary = report(results);
}

if (!noCleanup) {
  console.log('\n[run] cleanup…');
  try {
    if (ctx.db != null) await cleanup(ctx.db);
    await restoreSmtp();
  } catch (error) {
    console.error('[run] cleanup error:', error instanceof Error ? error.message : error);
  }
}
if (!keepStack) await stopStack();
console.log(`\n[run] done: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.skip} SKIP / ${summary.total} total`);
process.exit(summary.fail > 0 || failedToBoot ? 1 : 0);
