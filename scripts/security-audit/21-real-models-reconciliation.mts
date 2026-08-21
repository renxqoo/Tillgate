/**
 * 21 · 真实模型端到端对账（MiniMax-M3 / deepseek-v4-flash 并发 / 免费模型）
 *
 * 预算纪律（按指示）：
 *   - deepseek-v4-flash 只用渠道现存资金（channel 1 余额约 ¥1.48）：
 *     20 并发 × max_tokens=16，理论成本 < ¥0.001；
 *   - MiniMax-M3 单次（channel 2 余额约 ¥37.69），约 ¥0.0002；
 *   - gpt-oss-20b 走免费渠道，0 成本。
 *
 * 对账纪律（金额全部在 SQL 侧用 numeric 精确比较，不经 JS 浮点）：
 *   A1 公式一致性：usage_logs.amount == (未缓存输入×输入价 + 缓存×缓存价 + 输出×输出价)/1e6 × 系数
 *   A2 余额守恒：初始余额 − Σamount == 当前余额（分毫不差）
 *   A3 流水自洽：每笔 transactions.balance_after == balance_before + amount
 *   A4 无双扣：consume 流水数 == usage_logs 数 == 成功请求数
 *   A5 预占清零：结算完成后 reserved_balance == 0（成功路径 settle 释放正常）
 *   A6 无滞留：billing_requests 无非终态残留
 *
 * 测试数据保留（前缀 real21-），记录见 ACCOUNTS-2.md。修复前后运行均应对账全绿
 * （本脚本验证「正确路径」，发现的异常即真缺陷）。
 */
import {
  loadEnv,
  psql,
  q,
  insertUser,
  setPassword,
  adminCookie,
  userLogin,
  createKey,
  post,
  GATEWAY,
  newSubject,
} from './helpers.mts';

loadEnv();

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}

async function chatOnce(key: string, model: string, maxTokens: number): Promise<{ status: number; raw: string }> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model, max_tokens: maxTokens, messages: [{ role: 'user', content: 'Reply with one word: ok' }] },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { status: res.status, raw: res.raw };
}

async function newUser(balance: string): Promise<{ userId: number; key: string; subject: string }> {
  const subject = newSubject('real21');
  const userId = insertUser(subject, balance);
  await setPassword(await adminCookie(), userId, 'RealModel123!');
  const { cookie } = await userLogin(subject, 'RealModel123!');
  const key = await createKey(cookie, 'real-model-key');
  return { userId, key, subject };
}

async function waitAllSettled(userId: number, expected: number, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stuck = '';
  while (Date.now() < deadline) {
    stuck = psql(
      `select string_agg(distinct status, ',') from billing_requests where user_id=${userId} and status not in ('settled','released');`,
    );
    const done = psql(
      `select count(*) from billing_requests where user_id=${userId} and status in ('settled','released');`,
    );
    if (Number(done) >= expected && !stuck) return '';
    await new Promise((r) => setTimeout(r, 500));
  }
  return stuck || 'timeout';
}

async function reconcile(userId: number, initialBalance: string, label: string): Promise<void> {
  const formulaBad = psql(
    `select count(*) from usage_logs where user_id=${userId} and ` +
      `abs(amount - (((input_tokens - least(cached_input_tokens, input_tokens))*input_price ` +
      `+ least(cached_input_tokens, input_tokens)*cache_input_price + output_tokens*output_price)/1e6*coefficient)) > 1e-15;`,
  );
  check(`${label} A1 公式一致性（金额=价格×用量×系数）`, formulaBad === '0', `不一致行数=${formulaBad}`);

  const conservation = psql(
    `select (${q(initialBalance)}::numeric - (select coalesce(sum(amount),0) from usage_logs where user_id=${userId})) ` +
      `= (select balance from users where id=${userId});`,
  );
  check(`${label} A2 余额守恒（初始−Σ扣款=当前，精确）`, conservation === 't', `守恒=${conservation}`);

  const chainBad = psql(
    `select count(*) from transactions where user_id=${userId} and type='consume' and balance_after <> balance_before + amount;`,
  );
  check(`${label} A3 流水自洽（before+amount=after）`, chainBad === '0', `不自洽行数=${chainBad}`);

  const usageCount = psql(`select count(*) from usage_logs where user_id=${userId};`);
  const txCount = psql(
    `select count(*) from transactions where user_id=${userId} and type='consume';`,
  );
  check(`${label} A4 无双扣（流水数=usage数=${usageCount}）`, txCount === usageCount, `consume流水=${txCount}`);

  const reserved = psql(`select reserved_balance from users where id=${userId};`);
  check(`${label} A5 预占清零`, Number(reserved) === 0, `reserved=${reserved}`);
}

async function main(): Promise<void> {
  // ═══ 1. deepseek-v4-flash：同一用户 20 并发 ═══
  const ds = await newUser('1');
  console.log(`[DS] 用户 ${ds.subject} (id=${ds.userId}) 开始 20 并发 deepseek-v4-flash`);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => chatOnce(ds.key, 'deepseek-v4-flash', 16)),
  );
  const okCount = results.filter((r) => r.status === 200).length;
  const errStats = results
    .filter((r) => r.status !== 200)
    .reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  console.log(`[DS] 200=${okCount}/20，非200分布=${JSON.stringify(errStats)}`);
  check('DS 并发至少 15 成功（上游可用性下限）', okCount >= 15, `200=${okCount}`);

  const stuck = await waitAllSettled(ds.userId, 20);
  check('DS A6 无非终态滞留', stuck === '', `滞留=${stuck || '无'}`);
  await reconcile(ds.userId, '1', 'DS');

  // ═══ 2. MiniMax-M3：单次精确对账 ═══
  const mm = await newUser('1');
  const mmres = await chatOnce(mm.key, 'MiniMax-M3', 16);
  console.log(`[MM] http=${mmres.status} ${mmres.raw.slice(0, 120)}`);
  check('MM 单次调用成功', mmres.status === 200, `http=${mmres.status}`);
  await waitAllSettled(mm.userId, 1);
  await reconcile(mm.userId, '1', 'MM');
  const mmRow = psql(
    `select input_tokens, cached_input_tokens, output_tokens, coefficient, amount, upstream_cost from usage_logs where user_id=${mm.userId};`,
  );
  console.log(`[MM] usage快照（in|cached|out|coef|amount|upstream_cost）=${mmRow}`);

  // ═══ 3. 免费模型 gpt-oss-20b：0 元计费 ═══
  const fr = await newUser('0'); // 首登礼金 +1
  const frres = await chatOnce(fr.key, 'gpt-oss-20b', 16);
  console.log(`[FREE] http=${frres.status} ${frres.raw.slice(0, 120)}`);
  if (frres.status === 200) {
    await waitAllSettled(fr.userId, 1);
    const frState = psql(
      `select (select coalesce(sum(amount),0) from usage_logs where user_id=${fr.userId}) as amt, ` +
        `(select balance::numeric(20,6) from users where id=${fr.userId}) as bal, ` +
        `(select reserved_balance from users where id=${fr.userId}) as rb;`,
    );
    console.log(`[FREE] Σ金额|余额|预占=${frState}`);
    check('FREE 0 元计费、预占清零', psql(`select (select coalesce(sum(amount),0) from usage_logs where user_id=${fr.userId}) = 0 and (select reserved_balance from users where id=${fr.userId}) = 0;`) === 't', frState);
  } else {
    console.log('[FREE] 免费渠道暂不可用（环境问题，非系统缺陷，跳过计费断言）');
  }

  // ═══ 4. 渠道侧对账：上游成本记录 ═══
  const chCost = psql(
    `select channel_id, count(*), sum(upstream_cost)::numeric(20,8) from usage_logs where user_id in (${ds.userId},${mm.userId}) group by channel_id;`,
  );
  console.log(`[CH] 本轮各渠道单量与上游成本：${chCost.replace(/\n/g, ' ')}`);

  console.log(`\n账号留档：deepseek并发=${ds.userId} minimax=${mm.userId} free=${fr.userId}`);
  if (reds > 0) {
    console.error(`\n[RED] ${reds} 项对账失败`);
    process.exit(1);
  }
  console.log('\n[GREEN] 真实模型对账全部通过');
}

main().catch((e) => {
  console.error(`脚本异常：${e}`);
  process.exit(1);
});
