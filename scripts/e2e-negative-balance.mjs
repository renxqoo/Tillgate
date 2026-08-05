/**
 * 端到端真实测试：透支→负余额→阻断→充值恢复→流水正确（用 psql 做 DB，无 pg 依赖）。
 * 用法：node scripts/e2e-negative-balance.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ---- 加载 .env ----
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
const DATABASE_URL = process.env.DATABASE_URL;
const GATEWAY = 'http://127.0.0.1:8787';
const MODEL = 'deepseek-chat';

const psql = (sql) => {
  const out = execSync(`psql "${DATABASE_URL}" -At -F '|' -c ${JSON.stringify(sql)}`, { encoding: 'utf8' });
  return out.trim();
};
const psqlRows = (sql) => {
  const out = psql(sql);
  if (!out) return [];
  return out.split('\n').map((line) => line.split('|'));
};

let STEP = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const section = (t) => console.log(`\n━━━ [${++STEP}] ${t} ━━━`);

async function callGateway(token, prompt, maxTokens = 800) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function main() {
  console.log('🧪 端到端真实测试：允许负余额模型（真实 DeepSeek 上游）');
  const health = await fetch(`${GATEWAY}/healthz`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error('gateway 未响应');
  ok('gateway 存活');

  section('建用户（余额 1 厘）+ API Key');
  const subject = 'e2e-neg-' + Date.now();
  const token = 'ag_' + randomUUID().replace(/-/g, '');
  const keyHash = createHash('sha256').update(token).digest('hex');
  const [[uid]] = psqlRows(`INSERT INTO users (issuer, subject, identity_provider, display_name, balance, rate_card_id, status) VALUES ('test', '${subject}', 'local', 'E2E', 1, 1, 0) RETURNING id`);
  psql(`INSERT INTO api_keys (key_hash, key_preview, user_id, name, status) VALUES ('${keyHash}', 'ag_****${token.slice(-4)}', ${uid}, 'e2e', 0)`);
  ok(`userId=${uid} balance=1厘`);

  try {
    // === 第一次：透支 ===
    section('第一次真实调用（1 厘 → 必透支）');
    // 强制长输出：DeepSeek 输出价 2000 厘/百万 token，要求写长文 → amount > 余额 1 → 透支
    const r1 = await callGateway(token, '请写一篇关于人工智能发展历史的详细介绍，要求至少600字，分多个段落展开论述，越详细越好。');
    console.log(`   HTTP ${r1.status}`);
    if (r1.status !== 200) { console.log('  ', JSON.stringify(r1.body).slice(0, 300)); throw new Error('第一次应 200'); }
    ok('上游真实返回 200');
    // 等结算
    let bal1 = null, logs1 = [];
    for (let i = 0; i < 40; i++) {
      logs1 = psqlRows(`SELECT amount, payg_amount, status, input_tokens, output_tokens FROM usage_logs WHERE user_id=${uid} ORDER BY id`);
      if (logs1.length >= 1) { bal1 = psql(`SELECT balance FROM users WHERE id=${uid}`); break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (bal1 === null) throw new Error('等待结算超时');
    bal1 = Number(bal1);
    console.log(`   余额: 1 → ${bal1} | usage: amount=${logs1[0][0]} payg=${logs1[0][1]} status=${logs1[0][2]} tokens=${logs1[0][3]}+${logs1[0][4]}`);
    if (bal1 >= 0) throw new Error(`透支后余额应<0，实际 ${bal1}`);
    if (Number(logs1[0][2]) !== 0) throw new Error(`status 应=0`);
    if (Number(logs1[0][1]) !== Number(logs1[0][0])) throw new Error(`payg 应=amount`);
    ok('透支：余额负数=欠款，status=0，payg=amount');

    const [[bb, ba, amt]] = psqlRows(`SELECT balance_before, balance_after, amount FROM transactions WHERE user_id=${uid} AND type='consume'`);
    if (Math.abs(Number(bb) - Number(ba)) !== Math.abs(Number(amt))) throw new Error(`流水不变量破坏`);
    console.log(`   流水: before=${bb} after=${ba} amount=${amt} |Δ|=|amount| ✓`);
    ok('对账不变量成立');

    // === 第二次：应 402 ===
    section('第二次调用（余额为负 → 应 402）');
    const r2 = await callGateway(token, '再说');
    console.log(`   HTTP ${r2.status} ${r2.body?.error?.code ?? ''}`);
    if (r2.status !== 402) { console.log('  ', JSON.stringify(r2.body).slice(0, 300)); throw new Error(`应 402，实际 ${r2.status}`); }
    ok('欠款用户被拦截（402）');
    const logs2 = psqlRows(`SELECT id FROM usage_logs WHERE user_id=${uid}`);
    if (logs2.length !== 1) throw new Error(`被拦不应产生 usage_logs，实际 ${logs2.length}`);
    ok('拦截未产生计费（hold 阶段拦截，未调上游）');

    // === 充值 ===
    section('充值 100000 厘（自动抵扣欠款）');
    const before = Number(psql(`SELECT balance FROM users WHERE id=${uid}`));
    psql(`UPDATE users SET balance = balance + 100000, updated_at = now() WHERE id=${uid}`);
    // 失效 gateway 余额缓存（模拟真实充值路径：changeBalance/redeemCode 已 DEL 缓存）
    // 本地 redis 有 requirepass root123（与 .env REDIS_URL 一致）
    execSync(`redis-cli -h 127.0.0.1 -p 6379 -a root123 DEL billing:balance:${uid} >/dev/null 2>&1`);
    const after = Number(psql(`SELECT balance FROM users WHERE id=${uid}`));
    console.log(`   余额: ${before} → ${after}（= ${before} + 100000）`);
    if (after !== before + 100000) throw new Error('充值计算错');
    if (after <= 0) throw new Error('充值后应正');
    ok('充值自动抵扣欠款，余额转正');

    // === 第三次：应成功 ===
    section('第三次调用（充值后 → 应成功）');
    const r3 = await callGateway(token, '请写一首关于秋天的诗，至少写四段。');
    console.log(`   HTTP ${r3.status}`);
    if (r3.status !== 200) { console.log('  ', JSON.stringify(r3.body).slice(0, 300)); throw new Error(`充值后应 200，实际 ${r3.status}`); }
    for (let i = 0; i < 40; i++) {
      const c = psql(`SELECT count(*) FROM usage_logs WHERE user_id=${uid}`);
      if (Number(c) >= 2) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const logs3 = psqlRows(`SELECT amount, status FROM usage_logs WHERE user_id=${uid} ORDER BY id`);
    const balFinal = Number(psql(`SELECT balance FROM users WHERE id=${uid}`));
    if (logs3.length !== 2) throw new Error(`应有 2 条 usage_logs，实际 ${logs3.length}`);
    if (Number(logs3[1][1]) !== 0) throw new Error('第二条 status 应=0');
    ok('充值后恢复正常消费');

    // === 最终对账 ===
    section('最终对账');
    const consume = psqlRows(`SELECT amount, balance_before, balance_after FROM transactions WHERE user_id=${uid} AND type='consume' ORDER BY id`);
    console.log(`   consume 流水 ${consume.length} 条`);
    for (const [a, b, c] of consume) {
      if (Math.abs(Number(b) - Number(c)) !== Math.abs(Number(a))) throw new Error(`流水不变量破坏: ${b}-${c}≠${a}`);
    }
    const sumConsume = consume.reduce((s, [a]) => s + Number(a), 0);
    const expected = 1 + 100000 + sumConsume;
    console.log(`   Σconsume=${sumConsume} 最终=${balFinal} 预期=${expected}`);
    if (balFinal !== expected) throw new Error(`对账不平: ${balFinal}≠${expected}`);
    ok('全部流水连续，余额对账精确平');

    console.log('\n🎉 端到端通过：负余额模型在真实 DeepSeek 上游链路下完全自洽');
    console.log('\n证据摘要:');
    console.log(`  • 透支：1 → ${bal1}（负数欠款），status=0 payg=amount`);
    console.log(`  • 阻断：第二次 402（欠款被拦，未调上游，无新计费）`);
    console.log(`  • 充值：${before}+100000=${after}（自动抵扣）`);
    console.log(`  • 恢复：第三次成功，最终余额 ${balFinal}`);
    console.log(`  • 对账：${consume.length} 条流水全连续，余额精确平`);
  } finally {
    // FK 顺序：先删引用 api_keys 的 request_logs，再删其余
    psql(`DELETE FROM request_logs WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id=${uid})`);
    psql(`DELETE FROM usage_logs WHERE user_id=${uid}`);
    psql(`DELETE FROM transactions WHERE user_id=${uid}`);
    psql(`DELETE FROM api_keys WHERE user_id=${uid}`);
    psql(`DELETE FROM users WHERE id=${uid}`);
    console.log('\n🧹 已清理');
  }
}

main().catch((e) => { console.error('\n💥 失败:', e.message); process.exit(1); });
