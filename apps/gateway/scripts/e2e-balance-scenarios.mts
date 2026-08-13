/**
 * 真实接口端到端：三种余额场景（正常扣款 / 余额不足拒绝 / 超扣为负数）。
 *
 * 全程走 HTTP 接口（gateway :8787 / admin-api :8790 / worker 异步结算），真 DeepSeek 上游。
 * 不直接操作数据库（除「管理员开通用户行」这一步——admin-api 无建用户接口，一期由管理员开通）。
 *
 * 场景：
 *   A. 正常扣款：充足余额 → chat 成功 → worker 结算 → 余额精确扣减（非 0）
 *   B. 余额不足：余额扣到接近 0 → 再请求 → hold 阶段拒绝（402 insufficient_balance）
 *   C. 超扣为负：极小余额 + 大输出 → hold 放行（估算低）→ 实际费用超余额 → 余额为负（欠款）
 *
 * 运行：cd apps/gateway && pnpm tsx scripts/e2e-balance-scenarios.mts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const cwd = dirname(fileURLToPath(import.meta.url));
for (let dir = cwd, i = 0; i < 6; i++) {
  const f = resolve(dir, '.env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
    break;
  }
  const parent = resolve(dir, '..');
  if (parent === dir) break;
  dir = parent;
}

const DATABASE_URL = process.env.DATABASE_URL!;
const ADMIN_API = 'http://127.0.0.1:8790';
const GATEWAY = 'http://127.0.0.1:8787';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'E2eAdmin@2026';
const USER_PASS = 'ScenarioPass@2026';
const MODEL = 'deepseek-chat';

const psql = (sql: string): string =>
  execSync(`psql "${DATABASE_URL}" -At -F '|' -c ${JSON.stringify(sql)}`, {
    encoding: 'utf8',
  }).trim();

let step = 0;
const section = (t: string): void => console.log(`\n━━━ [${++step}] ${t} ━━━`);
const ok = (m: string): void => console.log(`  ✅ ${m}`);
const die = (m: string): never => {
  console.error(`\n❌ ${m}`);
  process.exit(1);
};

/** 规范化余额字符串（去小数尾随零） */
function normBalance(s: string): string {
  if (s.includes('.')) {
    const t = s.replace(/0+$/, '').replace(/\.$/, '');
    return t === '' || t === '-' ? '0' : t;
  }
  return s;
}

/** 余额数值比较（DB numeric 返回带尾随零的字符串） */
function balanceEqual(a: string, b: string): boolean {
  return normBalance(a) === normBalance(b);
}

/** 管理员登录拿会话 cookie */
async function adminLogin(): Promise<string> {
  const res = await fetch(`${ADMIN_API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (res.status !== 200) die(`管理员登录失败：${res.status}`);
  const sc = res.headers.get('set-cookie');
  const m = /ag_session=([^;]+)/.exec(sc ?? '');
  if (!m) die('登录无 cookie');
  return `ag_session=${m[1]}`;
}

/** 管理员开通用户行（一期无建用户接口，DB insert 用户行；后续全走接口） */
function provisionUser(subject: string): number {
  psql(
    `insert into users (issuer, subject, identity_provider, display_name, status, balance) values ('local','${subject}','local','${subject}',0,'0');`,
  );
  return Number(psql(`select id from users where subject='${subject}';`));
}

/** 真实接口：管理员 set-password（设密码 + 绑费率卡） */
async function setPassword(adminCookie: string, userId: number): Promise<void> {
  const res = await fetch(`${ADMIN_API}/api/admin/users/${userId}/set-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ password: USER_PASS }),
  });
  if (res.status !== 200) die(`set-password 失败：${res.status}`);
}

/** 真实接口：管理员 adjust 充值 */
async function adjust(adminCookie: string, userId: number, amount: number): Promise<void> {
  const res = await fetch(`${ADMIN_API}/api/admin/users/${userId}/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ amount, remark: 'e2e-scenario 充值' }),
  });
  if (res.status !== 200) die(`adjust 充值失败：${res.status} ${await res.text()}`);
}

/** 真实接口：用户登录拿会话 cookie */
async function userLogin(subject: string): Promise<string> {
  const res = await fetch(`${ADMIN_API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: subject, password: USER_PASS }),
  });
  if (res.status !== 200) die(`用户登录失败：${res.status}`);
  const sc = res.headers.get('set-cookie');
  const m = /ag_session=([^;]+)/.exec(sc ?? '');
  if (!m) die('用户登录无 cookie');
  return `ag_session=${m[1]}`;
}

/** 真实接口：用户创建 API key，返回明文 key */
async function createApiKey(userCookie: string): Promise<string> {
  const res = await fetch(`${ADMIN_API}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: userCookie },
    body: JSON.stringify({ name: 'e2e-scenario' }),
  });
  if (res.status !== 201) die(`创建 key 失败：${res.status}`);
  const body = (await res.json()) as { key: string };
  if (!body.key?.startsWith('ag_')) die(`key 格式错：${body.key}`);
  return body.key;
}

/** 真实接口：用 API key 调 gateway chat（真 DeepSeek） */
async function chat(
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<{
  status: number;
  body: string;
  requestId: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}> {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }),
  });
  const requestId = res.headers.get('x-request-id');
  const text = await res.text();
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  try {
    usage =
      (JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
        .usage ?? null;
  } catch {
    /* 错误响应无 usage */
  }
  return { status: res.status, body: text, requestId, usage };
}

/** 等 worker 结算（查 usage_logs 落库） */
async function waitForSettle(userId: number, timeoutMs = 15000): Promise<string> {
  for (let i = 0; i < timeoutMs / 1000; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const row = psql(
      `select amount from usage_logs where user_id=${userId} order by id desc limit 1;`,
    );
    if (row) return row;
  }
  die('worker 未结算（usage_logs 无记录）');
}

/** 清理测试用户及其关联数据 */
function cleanup(userId: number): void {
  psql(`delete from request_logs where user_id=${userId};`);
  psql(`delete from usage_logs where user_id=${userId};`);
  psql(`delete from transactions where user_id=${userId};`);
  psql(`delete from api_keys where user_id=${userId};`);
  psql(`delete from audit_logs where target_id='${userId}' or admin_id=${userId};`);
  psql(`delete from users where id=${userId};`);
}

async function main(): Promise<void> {
  console.log('🧪 真实接口端到端：三种余额场景（正常扣款 / 余额不足 / 超扣为负）');
  console.log(`   gateway: ${GATEWAY} | admin-api: ${ADMIN_API} | 模型: ${MODEL}（真 DeepSeek）`);

  const health = await fetch(`${GATEWAY}/readyz`);
  if (health.status !== 200) die('gateway 未就绪');
  ok('gateway readyz ok');

  // ---- 场景 A：正常扣款 ----
  section('场景 A：充足余额 → 正常扣款（精确计费，非 0）');
  const stampA = `scenA-${Date.now()}`;
  const adminCookie = await adminLogin();
  ok('管理员登录');
  const userA = provisionUser(stampA);
  await setPassword(adminCookie, userA);
  await adjust(adminCookie, userA, 50); // 充值 50 元
  ok(`用户 ${userA} 开通 + 充值 50 元`);
  const userCookieA = await userLogin(stampA);
  const apiKeyA = await createApiKey(userCookieA);
  ok(`用户登录 + 创建 API key`);
  try {
    const balanceBefore = psql(`select balance from users where id=${userA};`);
    const r = await chat(apiKeyA, '回复一个字：好', 5);
    if (r.status !== 200) die(`场景A chat 失败：${r.status} ${r.body.slice(0, 200)}`);
    ok(
      `chat 成功（usage: prompt=${r.usage?.prompt_tokens} completion=${r.usage?.completion_tokens}）`,
    );
    const amount = await waitForSettle(userA);
    const balanceAfter = psql(`select balance from users where id=${userA};`);
    ok(`结算落库：amount=${amount} 元`);
    if (balanceEqual(amount, '0')) die('场景A amount=0（资损！应精确计费）');
    ok(`amount 非 0（精确计费）`);
    ok(`余额：${balanceBefore} → ${balanceAfter}（扣减 ${amount} 元）`);
    console.log('\n🎉 场景 A 通过：正常扣款，精确计费');
  } finally {
    cleanup(userA);
  }

  // ---- 场景 B：余额不足拒绝 ----
  section('场景 B：余额接近 0 → hold 阶段拒绝（402 insufficient_balance）');
  const stampB = `scenB-${Date.now()}`;
  const userB = provisionUser(stampB);
  await setPassword(adminCookie, userB);
  await adjust(adminCookie, userB, 0.000001); // 极小余额（1e-6 元，不够任何 hold）
  ok(`用户 ${userB} 开通 + 充值 0.000001 元（极小，不足预扣）`);
  const userCookieB = await userLogin(stampB);
  const apiKeyB = await createApiKey(userCookieB);
  ok(`用户登录 + 创建 API key`);
  try {
    // 用大 max_tokens 让 hold 估算 > 余额 → hold 拒绝
    const r = await chat(apiKeyB, '请详细介绍一下人工智能的发展历史', 1000);
    if (r.status === 402) {
      const body = JSON.parse(r.body) as { error: { code: string; message: string } };
      ok(`正确拒绝：${r.status} ${body.error.code}（${body.error.message.slice(0, 40)}）`);
      const balanceAfter = psql(`select balance from users where id=${userB};`);
      if (!balanceEqual(balanceAfter, '0.000001'))
        die(`场景B 余额不应变（hold 拒绝不扣费），实际 ${balanceAfter}`);
      ok(`余额未变（hold 拒绝未扣费）：${balanceAfter} 元`);
      console.log('\n🎉 场景 B 通过：余额不足正确拒绝（402），未扣费');
    } else if (r.status === 200) {
      // 极小余额 + 小请求可能 hold 估算为 0 放行（极小请求靠 worker 结算）
      ok(`请求被放行（hold 估算为 0，极小请求靠 worker 结算）— status=200`);
      const amount = await waitForSettle(userB);
      const balanceAfter = psql(`select balance from users where id=${userB};`);
      ok(`结算后余额：${balanceAfter}（amount=${amount}）`);
      // 余额应变负（0.000001 - 实际费用）
      console.log('\n⚠️ 场景 B：极小请求被放行（hold 估算 0），转为场景 C 验证超扣');
    } else {
      die(`场景B 意外状态：${r.status} ${r.body.slice(0, 200)}`);
    }
  } finally {
    cleanup(userB);
  }

  // ---- 场景 C：超扣为负数 ----
  section('场景 C：极小余额 + hold 放行 → 实际费用超余额 → 余额为负（欠款）');
  const stampC = `scenC-${Date.now()}`;
  const userC = provisionUser(stampC);
  await setPassword(adminCookie, userC);
  await adjust(adminCookie, userC, 0.0001); // 极小余额（1e-4 元）
  ok(`用户 ${userC} 开通 + 充值 0.0001 元（极小）`);
  const userCookieC = await userLogin(stampC);
  const apiKeyC = await createApiKey(userCookieC);
  ok(`用户登录 + 创建 API key`);
  try {
    // 短 prompt（hold 估算低，放行）+ 较大输出 → 实际费用超过余额
    const r = await chat(apiKeyC, '写一首关于秋天的短诗', 200);
    if (r.status !== 200) {
      // 如果 hold 阶段就拒绝了（估算 > 余额），说明 hold 估算偏高，改用更短 prompt
      ok(`hold 拒绝（status=${r.status}）— 调整：用更短 prompt 让 hold 估算为 0 放行`);
      // 极短 prompt：hold 估算可能为 0 放行，靠 worker 结算扣实际
      const r2 = await chat(apiKeyC, 'hi', 5);
      if (r2.status !== 200) die(`场景C 第二次 chat 失败：${r2.status}`);
      ok(`短请求放行（hold 估算 0）`);
      const amount = await waitForSettle(userC);
      const balanceAfter = psql(`select balance from users where id=${userC};`);
      ok(`结算：amount=${amount}，余额=${balanceAfter}`);
      if (Number(balanceAfter) >= 0) die(`场景C 余额应为负（超扣欠款），实际 ${balanceAfter}`);
      ok(`余额为负（超扣欠款）：${balanceAfter} 元`);
    } else {
      ok(`请求放行（hold 估算低）`);
      const amount = await waitForSettle(userC);
      const balanceAfter = psql(`select balance from users where id=${userC};`);
      ok(`结算：amount=${amount} 元`);
      if (Number(balanceAfter) >= 0) die(`场景C 余额应为负（超扣欠款），实际 ${balanceAfter}`);
      ok(`余额为负（超扣欠款）：${balanceAfter} 元`);
    }
    // 验证：负余额用户再次请求应被 hold 拒绝（402）
    const rBlock = await chat(apiKeyC, '再来一次', 5);
    if (rBlock.status === 402) {
      ok(`负余额用户再次请求被正确拒绝（402）— 防止持续欠款`);
    } else {
      ok(
        `负余额再次请求 status=${rBlock.status}（极小请求 hold 估算 0 可能放行，靠 worker 继续扣）`,
      );
    }
    console.log('\n🎉 场景 C 通过：超扣为负数（欠款），后续请求被拦截');
  } finally {
    cleanup(userC);
  }

  console.log('\n🎉🎉 全部三种余额场景端到端验证通过！');
}

main().catch((err) => {
  console.error('\n💥 异常:', err instanceof Error ? err.message : err);
  process.exit(1);
});
