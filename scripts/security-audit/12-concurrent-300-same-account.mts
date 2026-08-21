/**
 * 测试 12：同一账号（id=2917）5 把不同 Key ×5 并发（普通上下文）。
 * 复用既有账号；先放宽该用户 rpm_limit=400（避免每用户 60 RPM 把 5 并发挡在门外）。
 * 验证：无透支、无重复扣费、上游 429 全部 released、成功全部 settled、预留归 0。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  loadEnv,
  adminCookie,
  patch,
  post,
  psql,
  q,
  GATEWAY,
  ADMIN_API,
  isBugConfirmed,
  red,
  green,
  section,
} from './helpers.mts';

loadEnv();

const SUBJECT = 'credit-longctx-1786662297644-1-dgih';
const UID = 2917;
const MODEL = 'deepseek-v4-flash';
const CONCURRENCY = 100;

function normBalance(s: string): string {
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}
function num(s: string): number {
  return Number(normBalance(s));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 批量建 N 把 key（SQL 直插，避免 5 次 HTTP） */
function bulkCreateKeys(n: number): string[] {
  const tokens: string[] = [];
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const token = 'ag_' + randomUUID().replace(/-/g, '');
    const keyHash = createHash('sha256').update(token).digest('hex');
    const preview = 'ag_****' + token.slice(-4);
    tokens.push(token);
    rows.push(`('${keyHash}','${preview}',${UID},'cc5-k${i}',0)`);
  }
  // 分批插入，避免单条 SQL 过长
  for (let i = 0; i < rows.length; i += 5) {
    const chunk = rows.slice(i, i + 5).join(',');
    psql(`insert into api_keys (key_hash, key_preview, user_id, name, status) values ${chunk};`);
  }
  return tokens;
}

async function chat(key: string): Promise<{ http: number; requestId: string | null }> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content: '只回复两个字：你好' }], max_tokens: 8 },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { http: res.status, requestId: res.headers.get('x-request-id') };
}

async function main(): Promise<void> {
  console.log(`🧪 测试 12：同号 ${SUBJECT}（id=${UID}）5 Key ×5 并发`);
  let anyRed = false;
  try {
    section('放宽该用户 rpm_limit → 400（否则 5 并发被每用户 60 RPM 挡住）');
    const admin = await adminCookie();
    const p = await patch(`${ADMIN_API}/api/admin/users/${UID}`, { rpmLimit: 400 }, { cookie: admin });
    if (p.status !== 200) throw new Error(`PATCH rpm_limit 失败: ${p.status}`);
    green('rpm_limit=400 已生效');

    section('批量建 5 把 Key');
    const keys = bulkCreateKeys(CONCURRENCY);
    green(`5 把 Key 已建（账号 ${UID}）`);

    const before = psql(`select balance, reserved_balance from users where id=${UID};`);
    console.log(`   请求前: ${before}`);

    section('5 并发');
    const t0 = Date.now();
    const results = await Promise.all(keys.map((k) => chat(k)));
    const elapsed = Date.now() - t0;
    const httpDist = results.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.http)] = (acc[String(r.http)] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`   HTTP 分布: ${JSON.stringify(httpDist)}（耗时 ${elapsed}ms）`);

    await sleep(6000);
    const terminal: Record<string, number> = {};
    let settled = 0;
    let released = 0;
    let dead = 0;
    let uncertain = 0;
    for (const r of results) {
      if (!r.requestId) continue;
      const st = psql(`select status from billing_requests where request_id=${q(r.requestId)};`);
      terminal[st] = (terminal[st] ?? 0) + 1;
      if (st === 'settled') settled += 1;
      else if (st === 'released') released += 1;
      else if (st === 'dead') dead += 1;
      else if (st === 'uncertain') uncertain += 1;
    }
    console.log(`   billing 终态: ${JSON.stringify(terminal)}`);

    const after = psql(`select balance, reserved_balance, credit_limit from users where id=${UID};`);
    const [balAfter, resAfter, credit] = after.split('|');
    console.log(`   请求后: balance=${balAfter} reserved=${resAfter} credit_limit=${credit}`);

    if (dead > 0 || uncertain > 0) {
      anyRed = true;
      console.error(`   🔴 [异常单] dead=${dead} uncertain=${uncertain}`);
    }
    if (settled + released < results.length) {
      anyRed = true;
      console.error(`   🔴 [未收敛] settled+released=${settled + released} < ${results.length}`);
    }
    if (num(balAfter) < -num(credit)) {
      anyRed = true;
      console.error(`   🔴 [透支] balance=${balAfter} < -credit_limit(-${credit})`);
    }
    if (num(resAfter) !== 0) {
      anyRed = true;
      console.error(`   🔴 [预留未释放] reserved=${resAfter}`);
    } else {
      green(`5 并发通过：${settled} settled + ${released} released，reserved 归 0、无透支`);
    }
    if (anyRed) red('同号 5 并发存在异常', '详见上方 🔴');
    green('同号 5 并发全部通过');
  } finally {
    console.log('\n（保留账号与流水未清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
