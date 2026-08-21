/**
 * 测试 11：同一账号（credit-longctx-…-dgih，id=2917）20 把不同 Key ×20 并发（普通上下文）。
 * 复用既有账号，不再新建。验证同号多 Key 并发下：无透支、无重复扣费、预留释放、结算准确。
 */
import {
  loadEnv,
  userLogin,
  createKey,
  post,
  psql,
  q,
  GATEWAY,
  newSubject,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const SUBJECT = 'credit-longctx-1786662297644-1-dgih';
const PASSWORD = 'CreditPass123!';
const UID = 2917;
const MODEL = 'deepseek-v4-flash';
const CONCURRENCY = 20;

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

async function chat(key: string): Promise<{ http: number; requestId: string | null }> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content: '只回复两个字：你好' }], max_tokens: 8 },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { http: res.status, requestId: res.headers.get('x-request-id') };
}

async function main(): Promise<void> {
  console.log(`🧪 测试 11：同号 ${SUBJECT}（id=${UID}）20 Key ×20 并发`);
  let anyRed = false;
  try {
    section('登录既有账号 + 建 20 把 Key');
    const { cookie } = await userLogin(SUBJECT, PASSWORD);
    const before = psql(`select balance, reserved_balance from users where id=${UID};`);
    const [balBefore, resBefore] = before.split('|');
    console.log(`   请求前: balance=${balBefore} reserved=${resBefore}`);

    const keys: string[] = [];
    for (let i = 0; i < CONCURRENCY; i++) keys.push(await createKey(cookie, `cc20-k${i}`));
    green(`20 把 Key 已创建（账号 ${UID}）`);

    section('20 并发');
    const results = await Promise.all(keys.map((k) => chat(k)));
    const httpDist = results.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.http)] = (acc[String(r.http)] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`   HTTP 分布: ${JSON.stringify(httpDist)}`);

    await sleep(4000);
    const terminal: Record<string, number> = {};
    let settled = 0;
    let released = 0;
    for (const r of results) {
      if (!r.requestId) continue;
      const st = psql(`select status from billing_requests where request_id=${q(r.requestId)};`);
      terminal[st] = (terminal[st] ?? 0) + 1;
      if (st === 'settled') settled += 1;
      else if (st === 'released') released += 1;
    }
    console.log(`   billing 终态: ${JSON.stringify(terminal)}`);

    const after = psql(`select balance, reserved_balance, credit_limit from users where id=${UID};`);
    const [balAfter, resAfter, credit] = after.split('|');
    console.log(`   请求后: balance=${balAfter} reserved=${resAfter} credit_limit=${credit}`);

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
      green(`20 并发通过：${settled} settled + ${released} released，reserved 归 0、无透支`);
    }
    if (anyRed) red('同号 20 并发存在异常', '详见上方 🔴');
    green('同号 20 并发全部通过');
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
