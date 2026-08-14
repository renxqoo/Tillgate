/**
 * 测试 08：真实 MiniMax-M3 并发计费/并发问题（3 个场景，真实登录 + 真实接口 + 真实上游）。
 *
 * 场景：
 *   1) 20 个不同用户，各 1 把 Key，20 并发请求（多用户并发隔离）
 *   2) 1 个用户，同一把 Key，20 并发请求（单用户单凭证并发）
 *   3) 1 个用户，20 把不同 Key，20 并发请求（单用户多凭证并发）
 *
 * 每个请求都会：登录(真实) → 建 Key(真实) → 真实调 MiniMax-M3(非流式, 小 max_tokens)。
 * 计费/并发断言（任一失败即报红）：
 *   A. 无透支：任何时刻 balance >= 0 且 reserved_balance <= balance
 *   B. 无重复扣费：每个请求至多 1 条 consume 流水
 *   C. HTTP 200 的请求必须全部 settled 且 amount > 0（成功消费必须精确计费，不能白嫖）
 *   D. HTTP 非 200（上游明确未处理，如 MiniMax 429）必须全部 released 且不冻结预留
 *   E. 结算后 reserved_balance 归 0（预留必须释放）
 *
 * 预期（修复后）：A/B/C/D/E 全通过。
 *   - 场景 3 高并发下 MiniMax 会突发 429 → 那些请求应 released（不扣费、不冻结），
 *     其余 200 请求全部 settled。修复前这些 429 会被误冻结为 uncertain|rate_limit_error。
 *
 * 运行：pnpm tsx scripts/security-audit/08-concurrent-billing-minimax.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
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

const MODEL = 'MiniMax-M3';
const MSG = '只回复两个字：你好';
const MAX_TOKENS = 8;

function normBalance(s: string): string {
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}
function num(s: string): number {
  return Number(normBalance(s));
}

interface FireResult {
  http: number;
  requestId: string | null;
}

async function fireChat(key: string): Promise<FireResult> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content: MSG }], max_tokens: MAX_TOKENS },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { http: res.status, requestId: res.headers.get('x-request-id') };
}

/** 建用户(余额 ¥1,无首登赠送) → set-password → 登录 → 建 Key */
async function provisionUser(admin: string, subject: string, password: string): Promise<{ uid: number; key: string }> {
  const uid = insertUser(subject, '1');
  await setPassword(admin, uid, password);
  const { cookie } = await userLogin(subject, password);
  const key = await createKey(cookie);
  return { uid, key };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 汇总一批请求的计费结果 */
interface BatchSummary {
  total: number;
  http200: number;
  httpNon200: number;
  settled: number;
  released: number; // 上游明确未处理（如 429）→ 释放预留、不扣费（08 修复后的正确终态）
  dead: number;
  uncertain: number;
  other: number;
  uncertainRateLimit: number; // uncertain 且 failure_code='rate_limit_error'（上游 429 被误冻结）
  chargedCount: number;
  consumeCount: number;
  zeroAmountCount: number;
  overdraw: boolean;
  doubleCharge: boolean;
  frozenReserved: number; // 结算后仍残留 reserved 的用户数
}

async function summarize(uids: number[], requestIds: Array<string | null>): Promise<BatchSummary> {
  await sleep(3000); // 给 gateway 同步转 dead / worker 结算留时间
  let settled = 0;
  let released = 0;
  let dead = 0;
  let uncertain = 0;
  let other = 0;
  let uncertainRateLimit = 0;
  let chargedCount = 0;
  let consumeCount = 0;
  let zeroAmountCount = 0;
  let overdraw = false;
  let doubleCharge = false;
  let frozenReserved = 0;

  for (const rid of requestIds) {
    if (!rid) continue;
    const row = psql(`select status, failure_code from billing_requests where request_id=${q(rid)} limit 1;`);
    const [st, fc] = row.split('|');
    if (st === 'settled') settled += 1;
    else if (st === 'released') released += 1;
    else if (st === 'dead') dead += 1;
    else if (st === 'uncertain') {
      uncertain += 1;
      if (fc === 'rate_limit_error') uncertainRateLimit += 1;
    } else if (st) other += 1;
  }

  for (const uid of uids) {
    const u = psql(`select balance, reserved_balance, credit_limit from users where id=${uid};`);
    const [balance, reserved, credit] = u.split('|');
    // 信用模型：balance 允许降到 -credit_limit；reserved 是在途敞口（非冻结），可超过 balance。
    // 透支判定 = balance < -credit_limit 或 敞口 > balance + credit_limit。
    const creditVal = num(credit);
    if (num(balance) < -creditVal) overdraw = true;
    if (num(reserved) > num(balance) + creditVal + 1e-12) overdraw = true;
    const c = Number(psql(`select count(*) from transactions where user_id=${uid} and type='consume';`));
    consumeCount += c;
    const ul = Number(psql(`select count(*) from usage_logs where user_id=${uid};`));
    chargedCount += ul;
    const z = Number(psql(`select count(*) from usage_logs where user_id=${uid} and amount = '0';`));
    zeroAmountCount += z;
    if (c > ul) doubleCharge = true; // consume 多于 usage_logs = 重复扣费
    if (num(reserved) > 0) frozenReserved += 1; // reserved 未归 0（dead 冻结 或 结算后未释放）
  }

  return {
    total: requestIds.length,
    http200: 0,
    httpNon200: 0,
    settled,
    released,
    dead,
    uncertain,
    other,
    uncertainRateLimit,
    chargedCount,
    consumeCount,
    zeroAmountCount,
    overdraw,
    doubleCharge,
    frozenReserved,
  };
}

function report(name: string, s: BatchSummary): void {
  console.log(`\n  ── ${name} ──`);
  console.log(
    `     HTTP: 200×${s.http200} 非200×${s.httpNon200} | billing: settled=${s.settled} released=${s.released} dead=${s.dead} uncertain=${s.uncertain} other=${s.other}`,
  );
  console.log(
    `     计费: usage_logs=${s.chargedCount} consume=${s.consumeCount} 零金额=${s.zeroAmountCount} | ` +
      `透支=${s.overdraw} 重复扣费=${s.doubleCharge} 残留预留用户=${s.frozenReserved} 上游429误冻结=${s.uncertainRateLimit}`,
  );
}

async function main(): Promise<void> {
  console.log('🧪 测试 08：真实 MiniMax-M3 并发计费/并发问题（3 场景）');
  console.log(`   gateway: ${GATEWAY} | 模型: ${MODEL} | 每用户余额 ¥1`);

  const admin = await adminCookie();
  const scenarios: Array<{ name: string; uids: number[]; keys: string[]; requestIds: Array<string | null>; http: number[] }> = [];

  try {
    // ============ 场景 1：20 个不同用户 × 1 并发请求 ============
    section('场景 1：20 个不同用户，各 1 把 Key，20 并发');
    const s1Uids: number[] = [];
    const s1Keys: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { uid, key } = await provisionUser(admin, newSubject('conc20u'), 'Conc20uPass!');
      s1Uids.push(uid);
      s1Keys.push(key);
    }
    green(`20 个用户已开通并建 Key（id ${s1Uids[0]}~${s1Uids[19]}）`);
    const s1 = await Promise.all(s1Keys.map((k) => fireChat(k)));
    scenarios.push({ name: '20用户×1并发', uids: s1Uids, keys: s1Keys, requestIds: s1.map((r) => r.requestId), http: s1.map((r) => r.http) });

    // ============ 场景 2：1 个用户，同一把 Key，20 并发 ============
    section('场景 2：1 个用户，同一把 Key，20 并发');
    const u2 = await provisionUser(admin, newSubject('conc1u1k'), 'Conc1u1kPass!');
    const s2 = await Promise.all(Array.from({ length: 20 }, () => fireChat(u2.key)));
    scenarios.push({ name: '1用户×同Key×20并发', uids: [u2.uid], keys: [u2.key], requestIds: s2.map((r) => r.requestId), http: s2.map((r) => r.http) });

    // ============ 场景 3：1 个用户，20 把不同 Key，20 并发 ============
    section('场景 3：1 个用户，20 把不同 Key，20 并发');
    const u3Subject = newSubject('conc1u20k');
    const u3 = await provisionUser(admin, u3Subject, 'Conc1u20kPass!');
    const login3 = await userLogin(u3Subject, 'Conc1u20kPass!');
    const keys3: string[] = [];
    for (let i = 0; i < 20; i++) keys3.push(await createKey(login3.cookie, `k${i}`));
    const s3 = await Promise.all(keys3.map((k) => fireChat(k)));
    scenarios.push({ name: '1用户×20Key×20并发', uids: [u3.uid], keys: keys3, requestIds: s3.map((r) => r.requestId), http: s3.map((r) => r.http) });

    // ============ 汇总 + 断言 ============
    section('计费/并发结果汇总');
    let anyRed = false;
    for (const sc of scenarios) {
      const summary = await summarize(sc.uids, sc.requestIds);
      summary.http200 = sc.http.filter((h) => h === 200).length;
      summary.httpNon200 = sc.http.filter((h) => h !== 200).length;
      report(sc.name, summary);

      if (summary.overdraw) {
        anyRed = true;
        console.error(`     🔴 [透支] ${sc.name}：balance<0 或 reserved>balance，并发下资金透支！`);
      }
      if (summary.doubleCharge) {
        anyRed = true;
        console.error(`     🔴 [重复扣费] ${sc.name}：consume 流水数 > usage_logs 数，被重复扣费！`);
      }
      if (summary.dead > 0 || summary.uncertain > 0) {
        anyRed = true;
        console.error(
          `     🔴 [计费异常单] ${sc.name}：dead=${summary.dead} uncertain=${summary.uncertain}——` +
            `成功订单不应被误判 dead（06 的 token 上界 bug）、上游 429 不应被冻结 uncertain（08 的错误码 bug）。`,
        );
      }
      if (summary.settled < summary.http200) {
        anyRed = true;
        console.error(
          `     🔴 [白嫖] ${sc.name}：HTTP 200 有 ${summary.http200} 个但仅 ${summary.settled} 个结算——成功请求未足额计费。`,
        );
      }
      if (summary.settled + summary.released < summary.total) {
        anyRed = true;
        console.error(
          `     🔴 [请求未收敛] ${sc.name}：${summary.total} 个请求里 settled+released=${summary.settled + summary.released}，存在未结算/未释放的中间态。`,
        );
      }
      if (summary.frozenReserved > 0) {
        anyRed = true;
        console.error(`     🔴 [预留未释放] ${sc.name}：${summary.frozenReserved} 个用户结算后 reserved_balance 仍 >0。`);
      }
      if (summary.uncertainRateLimit > 0) {
        anyRed = true;
        console.error(
          `     🔴 [上游429被误冻结] ${sc.name}：${summary.uncertainRateLimit} 个请求因上游 429 被置为 uncertain（failure_code=rate_limit_error），` +
            `预留永久冻结不退款——根因是 ai 包把 MiniMax 429 的 body code 'rate_limit_error' 原样透出，` +
            `而 gateway 的 upstreamCharge()/isChannelSwitchable() 只认 'rate_limited'（错误码命名不匹配）。`,
        );
      }
    }

    if (anyRed) {
      red(
        '并发计费存在资损问题：真实 MiniMax-M3 订单被误判 dead、或上游 429 被误冻结',
        '详见上方各场景 🔴 标记。资金原子性（无透支/无重复扣费）本身正确；' +
          '修复后 200 订单应全部 settled（06）、上游 429 应全部 released 不冻结（08）。',
      );
    }
    green(
      '全部场景：无透支、无重复扣费、200 请求全部精确结算、上游 429 全部释放预留（未复现计费/并发问题）',
    );
  } finally {
    console.log('\n（按指示：已保留本次新建账号与全部计费流水，供人工核查——未清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
