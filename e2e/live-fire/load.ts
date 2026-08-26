/**
 * 大规模负载脚本（分支无关,双形态 A/B 用）:
 *   bun e2e/live-fire/load.ts [TOTAL=10000] [USERS=2000] [WAVE=2000]
 *
 * - 直接 SQL 造用户/Key(scrypt 太慢,登录不需要) + admin adjust 真实注资;
 * - curl 波次风暴(受 ulimit -u≈2666 约束,WAVE 是并发在途峰值,不是同瞬总数);
 * - 结算排空等待 + X10 同款三不变量全库核验 + 抽样用户精确对账;
 * - 输出吞吐/延迟分位/失败分布。数据前缀 rt-load(cleanup() 可清)。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import { createDb, closeDb, type Db } from '@tillgate/db';
import { startStack, stopStack, URLS } from './lib/stack.ts';
import { seedCatalog, adminLogin, fund, cleanup, usageSum } from './lib/seed.ts';

const TOTAL = Number(process.argv[2] ?? 10_000);
const USERS = Number(process.argv[3] ?? 2_000);
const WAVE = Number(process.argv[4] ?? 2_000);
const PER = Math.ceil(TOTAL / USERS);
const DB_URL = process.env.DATABASE_URL as string;
// 万级风暴:全局限流放开(spawn 合并 process.env,网关会收到)
process.env.GLOBAL_RPM ??= '1000000';
const BODY = JSON.stringify({ model: 'rt-mini', messages: [{ role: 'user', content: 'load' }] });


/** execute 结果归一:node-pg 返回 {rows},Bun SQL 返回数组(双分支兼容) */
function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const rows = (r as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

const p50 = (xs: number[]) => xs[Math.floor(xs.length * 0.5)] ?? 0;
const p95 = (xs: number[]) => xs[Math.floor(xs.length * 0.95)] ?? 0;
const p99 = (xs: number[]) => xs[Math.floor(xs.length * 0.99)] ?? 0;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** 单发:返回 {code, 秒} */
function fire(key: string): Promise<{ code: number; t: number }> {
  return new Promise((resolve) => {
    const p = Bun.spawn([
      'curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{time_total}',
      '--max-time', '120', '-X', 'POST',
      '-H', 'content-type: application/json',
      '-H', `authorization: Bearer ${key}`,
      '-d', BODY,
      `${URLS.gw}/v1/chat/completions`,
    ], { stdout: 'pipe' });
    void p.exited.then(async () => {
      const [c, t] = (await new Response(p.stdout).text()).split(' ');
      resolve({ code: Number(c) || 0, t: Number(t) || 0 });
    });
  });
}

async function main() {
  console.log(`[load] boot 栈…`);
  await startStack();
  const seeded = await seedCatalog();
  const db: Db = seeded.db;
  // 幂等起跑:清上一轮 rt-load 残留(cleanup 只认 rt-fire 前缀,这里独立清 rt-load)
  await db.execute(sql`set session_replication_role = replica`);
  await db.execute(sql`delete from usage_logs where user_id in (select id from users where issuer = 'rt-load')`);
  await db.execute(sql`delete from billing_reservations where billing_request_id in (select request_id from billing_requests where user_id in (select id from users where issuer = 'rt-load'))`);
  await db.execute(sql`delete from billing_requests where user_id in (select id from users where issuer = 'rt-load')`);
  await db.execute(sql`delete from wallet_authorizations where account_id in (select id from wallet_accounts where user_id in (select id from users where issuer = 'rt-load'))`);
  await db.execute(sql`delete from wallet_transactions where id in (select distinct l.transaction_id from wallet_legs l join wallet_accounts a on a.id = l.account_id where a.user_id in (select id from users where issuer = 'rt-load'))`);
  await db.execute(sql`delete from wallet_legs where account_id in (select id from wallet_accounts where user_id in (select id from users where issuer = 'rt-load'))`);
  await db.execute(sql`delete from wallet_accounts where user_id in (select id from users where issuer = 'rt-load')`);
  await db.execute(sql`delete from api_keys where user_id in (select id from users where issuer = 'rt-load')`);
  await db.execute(sql`delete from users where issuer = 'rt-load'`);
  await db.execute(sql`delete from wallet_legs where transaction_id not in (select id from wallet_transactions)`);
  await db.execute(sql`set session_replication_role = default`);
  // 引导测试管理员(与 run.ts 同款,幂等)
  Bun.spawnSync([
    'bun', 'scripts/create-admin.ts',
    '--email=rt-admin@fire.test', '--password=Rt!AdminPass#7', '--role=super_admin', '--apply',
  ], { cwd: 'apps/admin-api', env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const token = await adminLogin();
  void token;

  console.log(`[load] 造 ${USERS} 用户×Key(直接 SQL)+ 注资(真实 admin adjust)…`);
  const tSeed = Date.now();
  const keys: string[] = [];
  for (let i = 0; i < USERS; i += 500) {
    const batch = Array.from({ length: Math.min(500, USERS - i) }, (_, j) => {
      const key = `sk_rt${Array.from(randomBytes(20)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      return { key, tag: `load-${i + j}` };
    });
    await db.execute(sql`
      insert into users (issuer, subject, identity_provider)
      select 'rt-load', tag, 'local' from (values ${sql.join(batch.map((b) => sql`(${b.tag})`), sql`, `)}) as v(tag)
      returning id`);
    // 逐行拿 id 再插 key(批量 returning 顺序不稳,这里以 tag 关联)
    const ids = await db.execute<{ id: number; subject: string }>(sql`
      select id, subject from users where issuer = 'rt-load' and subject in (${sql.join(batch.map((b) => sql`${b.tag}`), sql`, `)})`);
    const idByTag = new Map(rowsOf<{ id: number; subject: string }>(ids).map((r) => [r.subject, r.id]));
    console.log(`  [seed] batch ${i}: users=${rowsOf(ids).length} mapped=${idByTag.size}`);
    await db.execute(sql`
      insert into api_keys (key_hash, key_preview, user_id, name)
      values ${sql.join(batch.map((b) => sql`(${createHash('sha256').update(b.key).digest('hex')}, 'sk-load', ${idByTag.get(b.tag) ?? 0}, 'load')`), sql`, `)}`);
    keys.push(...batch.map((b) => b.key));
  }
  const fundable = rowsOf<{ id: number }>(await db.execute(sql`select id from users where issuer = 'rt-load' order by id`));
  await mapLimit(fundable.slice(0, USERS), 2,
    async (u) => { await fund(u.id, '1', randomUUID()); });
  console.log(`[load] 种子完成 ${Date.now() - tSeed}ms`);

  console.log(`[load] 风暴: TOTAL=${TOTAL} = ${USERS}用户×${PER},WAVE=${WAVE} 并发在途…`);
  const jobs: Array<() => Promise<{ code: number; t: number }>> = [];
  for (let i = 0; i < TOTAL; i++) jobs.push(() => fire(keys[i % keys.length]!));
  const results: Array<{ code: number; t: number }> = [];
  const t0 = Date.now();
  for (let i = 0; i < jobs.length; i += WAVE) {
    const slice = jobs.slice(i, i + WAVE);
    results.push(...(await Promise.all(slice.map((j) => j()))));
    process.stdout.write(`  波 ${Math.floor(i / WAVE) + 1}/${Math.ceil(jobs.length / WAVE)}: 累计 ${results.length} 次(${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  }
  const wall = Date.now() - t0;

  const ok = results.filter((r) => r.code === 200).length;
  const dist: Record<number, number> = {};
  for (const r of results) dist[r.code] = (dist[r.code] ?? 0) + 1;
  const lat = results.filter((r) => r.code === 200).map((r) => r.t).sort((a, b) => a - b);
  console.log(`\n[load] ⚡ 完成: ${ok}/${TOTAL} 成功 | 墙钟 ${(wall / 1000).toFixed(2)}s | 吞吐 ${(TOTAL / (wall / 1000)).toFixed(0)} req/s`);
  console.log(`[load] 延迟(成功): p50=${(p50(lat)).toFixed(3)}s p95=${(p95(lat)).toFixed(3)}s p99=${(p99(lat)).toFixed(3)}s max=${(lat.at(-1) ?? 0).toFixed(3)}s`);
  console.log(`[load] 状态分布: ${JSON.stringify(dist)}`);

  console.log(`[load] 等待结算排空…`);
  const tDrain = Date.now();
  for (;;) {
    const pending = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from billing_requests where status in ('settlement_pending','retry_wait','processing')`);
    if (Number(rowsOf<{ n: number }>(pending)[0]?.n ?? 1) === 0) break;
    if (Date.now() - tDrain > 300_000) { console.log(`[load] ⚠️ 排空超时(300s)`); break; }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log(`[load] 排空耗时 ${((Date.now() - tDrain) / 1000).toFixed(1)}s`);

  // X10 同款三不变量(全库) + 计数 + 抽样精确
  // 腿平衡口径对齐 X10:限定 rt-load 用户域(internal 平台账户的 admin 铸币腿按设计单边)
  const bad1 = await db.execute(sql`select count(*)::int as n from (select transaction_id from wallet_legs group by 1 having sum(amount) <> 0) x`);
  const bad2 = await db.execute(sql`select count(*)::int as n from wallet_accounts ac where ac.balance <> coalesce((select l.balance_after from wallet_legs l where l.account_id = ac.id order by l.id desc limit 1), 0)`);
  const bad3 = await db.execute(sql`select count(*)::int as n from wallet_accounts ac where ac.in_flight <> coalesce((select sum(a.amount) from wallet_authorizations a where a.account_id = ac.id and a.status = 'active'), 0)`);
  const usageN = await db.execute<{ n: number }>(sql`select count(*)::int as n from usage_logs where user_id in (select id from users where issuer = 'rt-load')`);
  const usageCount = Number(rowsOf<{ n: number }>(usageN)[0]?.n ?? -1);
  const b1 = Number(rowsOf<{ n: number }>(bad1)[0]?.n ?? -1);
  const b2 = Number(rowsOf<{ n: number }>(bad2)[0]?.n ?? -1);
  const b3 = Number(rowsOf<{ n: number }>(bad3)[0]?.n ?? -1);
  console.log(`[load] 不变量: 腿平衡✗${b1} 余额✗${b2} 在途✗${b3} | usage 行=${usageCount}/${TOTAL}`);

  const sampleIds = fundable.slice(0, 20).map((u) => u.id);
  const sums = await map_limit(sampleIds, 8, async (id) => String(await usageSum(db, id)));
  const uniform = new Set(sums).size === 1;
  console.log(`[load] 抽样 20 用户计费一致: ${uniform ? '✓ 全等(' + sums[0] + ')' : '✗ 不一致: ' + sums.slice(0, 3).join(',')} | 每用户期望 ${PER} 笔`);
  const counts = await db.execute<{ n: number }>(sql`select count(*)::int as n from usage_logs where user_id = ${sampleIds[0]}`);
  const firstUserCount = Number(rowsOf<{ n: number }>(counts)[0]?.n ?? -1);
  console.log(`[load] 抽样首用户 usage 笔数: ${firstUserCount}/${PER}`);

  // 退出码必须包含精确性不变量:三不变量只验「账自洽」,零计费(如全部 dead-letter
  // 释放授权)同样自洽——usage 行数=TOTAL、逐户全等、金额非零、首户笔数=PER
  // 是本 harness 的核心交付,漏判 = 全账单死亡也退出 0。
  const nonzero = uniform && new Decimal(sums[0] ?? '-1').gt(0);
  const pass =
    ok === TOTAL && b1 === 0 && b2 === 0 && b3 === 0 &&
    usageCount === TOTAL && nonzero && firstUserCount === PER;
  console.log(
    `[load] 判定: ${pass ? 'PASS' : 'FAIL'} (http ${ok}/${TOTAL}, 不变量 ${b1}/${b2}/${b3}, usage ${usageCount}/${TOTAL}, 抽样一致 ${uniform}, 首户 ${firstUserCount}/${PER})`,
  );
  console.log(`[load] 清理 rt-load 数据…`);
  await cleanup(db);
  await closeDb(db).catch(() => {});
  await stopStack();
  console.log(`[load] done`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('[load] FAILED:', e); process.exit(1); });
