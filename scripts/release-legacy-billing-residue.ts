/**
 * 一次性治理：释放历史计费异常残留（走正规账务命令，保留行、只释放敞口，全程审计）。
 *
 *   A. uncertain + rate_limit_error      → resolveUncertain(confirmed_no_charge)
 *      （08 修复前 429 透传残留：上游确定未计费，无论金额一律放行）
 *   B. dead + usage_exceeds_authorization → abandonDead
 *      （06 修复前字节上界误判残留：判定逻辑已删除，旧模型数据无法重结算，废弃释放）
 *
 * 幂等：operationId 固定为 governance:{kind}:{requestId}，重复运行安全。
 * 用法（gateway 包带 tsx 与全部 workspace 依赖；development 条件解析源码）：
 *   NODE_OPTIONS='--conditions=development' pnpm -C apps/gateway exec tsx ../../scripts/release-legacy-billing-residue.ts          # dry-run
 *   NODE_OPTIONS='--conditions=development' pnpm -C apps/gateway exec tsx ../../scripts/release-legacy-billing-residue.ts --apply  # 执行
 */
import { and, eq, inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import { createBillingOperations } from '@ai-gateway/ledger';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 加载根 .env（与 seed 脚本同法）
{
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const APPLY = process.argv.includes('--apply');
const db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');
const operations = createBillingOperations({ db });

type Row = { requestId: string; revision: number; reservedAmount: string };

async function main(): Promise<void> {
  const uncertainRows = (await db
    .select({
      requestId: billingRequests.requestId,
      revision: billingRequests.revision,
      reservedAmount: billingRequests.reservedAmount,
    })
    .from(billingRequests)
    .where(
      and(eq(billingRequests.status, 'uncertain'), eq(billingRequests.failureCode, 'rate_limit_error')),
    )) as Row[];
  const deadRows = (await db
    .select({
      requestId: billingRequests.requestId,
      revision: billingRequests.revision,
      reservedAmount: billingRequests.reservedAmount,
    })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.status, 'dead'),
        inArray(billingRequests.failureCode, [
          'usage_exceeds_authorization',
          'billing_receipt_usage_exceeds_authorization',
        ]),
      ),
    )) as Row[];

  console.log(`待治理：uncertain(rate_limit)=${uncertainRows.length} 单，dead(usage_exceeds)=${deadRows.length} 单`);
  console.log(`合计预扣敞口：${[...uncertainRows, ...deadRows].reduce((s, r) => s + Number(r.reservedAmount), 0).toFixed(4)} 元`);
  if (!APPLY) {
    console.log('dry-run：加 --apply 执行释放（走 resolveUncertain/abandonDead，审计 actor=system）');
    return;
  }

  let releasedA = 0;
  let skippedA = 0;
  for (const row of uncertainRows) {
    try {
      const r = await operations.resolveUncertain({
        operationId: `governance:release-429:${row.requestId}`,
        requestId: row.requestId,
        expectedRevision: row.revision,
        adminId: null,
        actor: 'system',
        decision: 'confirmed_no_charge',
        reason: '治理：08 修复前 429 透传残留（rate_limit_error），上游确定未计费',
      });
      if (r.replayed) skippedA += 1;
      else releasedA += 1;
    } catch {
      skippedA += 1; // 状态/版本已被移动（可能被 worker 自动通道先处理）
    }
  }

  let releasedB = 0;
  let skippedB = 0;
  for (const row of deadRows) {
    try {
      const r = await operations.abandonDead({
        operationId: `governance:abandon-legacy-usage-exceeds:${row.requestId}`,
        requestId: row.requestId,
        expectedRevision: row.revision,
        adminId: null,
        actor: 'system',
        reason: '治理：06 修复前字节上界误判残留，判定逻辑已删除；旧模型数据无法重结算，确认不收费',
      });
      if (r.replayed) skippedB += 1;
      else releasedB += 1;
    } catch {
      skippedB += 1;
    }
  }

  console.log(`完成：429 残留释放 ${releasedA}（跳过 ${skippedA}）；dead 残留废弃 ${releasedB}（跳过 ${skippedB}）`);
  const remain = await db
    .select({ status: billingRequests.status })
    .from(billingRequests)
    .where(inArray(billingRequests.status, ['uncertain', 'dead']));
  const byStatus = remain.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('复核队列剩余（应仅剩需人工的 network/真异常）：', byStatus);
  await db.$client.end();
}

main().catch(async (error) => {
  console.error('治理失败：', error);
  await db.$client.end().catch(() => {});
  process.exit(1);
});
