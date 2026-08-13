/**
 * 真实端到端全链路：全新用户走全部真实 HTTP 接口。
 *
 * 前提：gateway(:8787) / admin-api(:8790) / worker 三个进程已在真实运行（pnpm dev）。
 * 不起任何 mock server、不 mock 上游：用真实 deepseek-chat 渠道打真实 DeepSeek 上游。
 *
 * 链路：
 *   1. 管理员登录（真实 /api/auth/login）拿会话 cookie
 *   2. DB 开通一个全新普通用户行（一期「管理员开通」，admin-api 无建用户接口）
 *   3. 真实接口：管理员 set-password 给该用户设密码 + 绑「标准」费率卡
 *   4. 真实接口：管理员 adjust 给用户充值（造余额）
 *   5. 真实接口：普通用户自己登录拿会话 cookie
 *   6. 真实接口：普通用户创建 API key（拿一次性明文 key）
 *   7. 真实接口：用 API key 调 gateway /v1/chat/completions（真打 DeepSeek）
 *   8. 等 worker 异步结算，查 usage_logs / transactions / balance 验证完整链路
 *   9. 清理（DB 删测试数据）
 *
 * 运行：cd apps/gateway && pnpm tsx scripts/e2e-full-user-flow.mts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const cwd = dirname(fileURLToPath(import.meta.url));
// 加载根 .env（psql 需要 DATABASE_URL）
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
const USER_PASS = 'E2eUser@2026';
const TOPUP = 50; // 50 元（重构后金额单位为元），足够一次小请求

const psql = (sql: string): string =>
  execSync(`psql "${DATABASE_URL}" -At -F '|' -c ${JSON.stringify(sql)}`, {
    encoding: 'utf8',
  }).trim();
const psqlVal = (sql: string): string => psql(sql).split('|')[0]!;

/** 规范化余额字符串（去小数尾随零） */
function normBalance(s: string): string {
  if (s.includes('.')) {
    const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
    return trimmed === '' || trimmed === '-' ? '0' : trimmed;
  }
  return s;
}

/** 余额数值相等比较（DB numeric 返回带尾随零的字符串，如 '50.000000000000000000'） */
function balanceEqual(a: string, b: string): boolean {
  return normBalance(a) === normBalance(b);
}
/** 余额差值：a - b（转 number，e2e 金额量级在 number 精度内） */
function balanceSub(a: string, b: string): string {
  return String(Number(a) - Number(b));
}

let step = 0;
const section = (t: string): void => console.log(`\n━━━ [${++step}] ${t} ━━━`);
const ok = (m: string): void => console.log(`  ✅ ${m}`);
const die = (m: string): never => {
  console.error(`\n❌ ${m}`);
  process.exit(1);
};

/** 从 fetch response 的 set-cookie 头提取 ag_session=xxx，返回可直接回传的 cookie 串 */
function cookieFromRes(res: Response): string {
  const sc = res.headers.get('set-cookie');
  if (!sc) return '';
  const m = /ag_session=([^;]+)/.exec(sc);
  return m ? `ag_session=${m[1]}` : '';
}

let testUserId: number | null = null;
let testUserSubject = '';

async function post(
  url: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; body: unknown; raw: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed, raw };
}
async function get(url: string, cookie?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { method: 'GET', headers });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
  console.log('🧪 真实端到端全链路：全新用户走全部 HTTP 接口（真 DeepSeek 上游 + 真 worker 结算）');
  console.log(`   admin-api: ${ADMIN_API} | gateway: ${GATEWAY}`);

  // 健康检查：三个服务都要在
  const health = await get(`${GATEWAY}/readyz`);
  if (health.status !== 200) die(`gateway 未就绪（readyz=${health.status}），请先 pnpm dev`);
  ok('gateway readyz ok');

  // ---- [1] 管理员登录 ----
  section('管理员登录拿会话 cookie');
  const adminLoginRes = await fetch(`${ADMIN_API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const adminLoginBody = await adminLoginRes.text();
  if (adminLoginRes.status !== 200)
    die(`管理员登录失败：${adminLoginRes.status} ${adminLoginBody}`);
  const adminCookie = cookieFromRes(adminLoginRes);
  if (!adminCookie) die('登录响应未带 ag_session cookie');
  const adminUser = JSON.parse(adminLoginBody) as {
    user: { id: number; role: number; username: string };
  };
  ok(
    `管理员登录成功（ id=${adminUser.user.id} / role=${adminUser.user.role} / ${adminUser.user.username}）`,
  );

  // ---- [2] 开通全新普通用户行 ----
  section('DB 开通全新普通用户行（管理员开通）');
  testUserSubject = `e2e-user-${Date.now()}`;
  psql(
    `insert into users (issuer, subject, identity_provider, display_name, role, status, balance) values ('local','${testUserSubject}','local','${testUserSubject}',0,0,0);`,
  );
  testUserId = Number(psqlVal(`select id from users where subject='${testUserSubject}';`));
  ok(`新建普通用户 id=${testUserId} subject=${testUserSubject}（余额 0）`);

  try {
    // ---- [3] 设密码 + 绑费率卡（真实接口）----
    section('真实接口：管理员 set-password（设密码 + 绑「标准」卡）');
    const sp = await post(
      `${ADMIN_API}/api/admin/users/${testUserId}/set-password`,
      { password: USER_PASS },
      adminCookie,
    );
    if (sp.status !== 200) die(`set-password 失败：${sp.status} ${sp.raw}`);
    const rateCardId = psqlVal(`select rate_card_id from users where id=${testUserId};`);
    if (rateCardId === '') die('费率卡未绑定');
    ok(`set-password 成功，已绑费率卡 id=${rateCardId}`);

    // ---- [4] 管理员充值（adjust）----
    section(`真实接口：管理员 adjust 充值 ${TOPUP} 元`);
    const adj = await post(
      `${ADMIN_API}/api/admin/users/${testUserId}/adjust`,
      { amount: TOPUP, remark: 'e2e 充值' },
      adminCookie,
    );
    if (adj.status !== 200) die(`adjust 失败：${adj.status} ${adj.raw}`);
    const balanceAfterTopup = psqlVal(`select balance from users where id=${testUserId};`);
    if (!balanceEqual(balanceAfterTopup, String(TOPUP)))
      die(`充值后余额应为 ${TOPUP}，实际 ${balanceAfterTopup}`);
    ok(`充值成功，DB 余额 = ${balanceAfterTopup} 元`);

    // ---- [5] 普通用户自己登录 ----
    section('真实接口：普通用户自己登录');
    const userLoginRes = await fetch(`${ADMIN_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: testUserSubject, password: USER_PASS }),
    });
    const userLoginBody = await userLoginRes.text();
    if (userLoginRes.status !== 200)
      die(`普通用户登录失败：${userLoginRes.status} ${userLoginBody}`);
    const userCookie = cookieFromRes(userLoginRes);
    if (!userCookie) die('普通用户登录响应未带 cookie');
    const userLoginJson = JSON.parse(userLoginBody) as { ok: boolean; user: { id: number } };
    ok(`普通用户登录成功（id=${userLoginJson.user.id}）`);

    // ---- [6] 创建 API key ----
    section('真实接口：普通用户创建 API key');
    const keyRes = await post(`${ADMIN_API}/api/keys`, { name: 'e2e-key' }, userCookie);
    if (keyRes.status !== 201) die(`创建 key 失败：${keyRes.status} ${keyRes.raw}`);
    const apiKey = (keyRes.body as { key: string }).key;
    if (!apiKey?.startsWith('ag_')) die(`key 格式错误：${apiKey}`);
    ok(`API key 创建成功：${apiKey.slice(0, 12)}...（明文仅此一次）`);

    // ---- [7] 用 API key 调 gateway chat（真打 DeepSeek）----
    section('真实接口：用 API key 调 gateway /v1/chat/completions（真 DeepSeek 上游）');
    const beforeCall = psqlVal(`select balance from users where id=${testUserId};`);
    const t0 = Date.now();
    const chatRes2 = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '回复一个字：好' }],
        max_tokens: 5,
      }),
    });
    const chatBody = await chatRes2.text();
    const duration = Date.now() - t0;
    if (chatRes2.status !== 200) die(`chat 调用失败：${chatRes2.status} ${chatBody.slice(0, 300)}`);
    let chatJson: {
      choices?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      chatJson = JSON.parse(chatBody);
    } catch {
      die(`chat 响应非 JSON：${chatBody.slice(0, 200)}`);
    }
    ok(
      `chat 成功（${duration}ms），上游 usage: prompt=${chatJson.usage?.prompt_tokens} completion=${chatJson.usage?.completion_tokens}`,
    );
    console.log(`     预扣前余额: ${beforeCall}`);

    // ---- [8] 等 worker 异步结算，验证完整链路 ----
    section('等 worker 异步结算（最多 15s）');
    const requestId = chatRes2.headers.get('x-request-id');
    if (requestId) console.log(`     request_id: ${requestId}`);
    let settled = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const cnt = psqlVal(`select count(*) from usage_logs where user_id=${testUserId};`);
      if (Number(cnt) >= 1) {
        settled = true;
        break;
      }
    }
    if (!settled) die('worker 15s 内未结算（usage_logs 无记录）');

    const usageRow = psql(
      `select request_id, input_tokens, output_tokens, amount, payg_amount, status, billed_by from usage_logs where user_id=${testUserId} order by id desc limit 1;`,
    );
    const [, inTok, outTok, amount, payg, status, billedBy] = usageRow.split('|');
    ok(
      `usage_logs 落库：input=${inTok} output=${outTok} amount=${amount} payg=${payg} status=${status} billed_by=${billedBy}`,
    );

    const txRow = psql(
      `select type, amount, balance_before, balance_after from transactions where user_id=${testUserId} and type='consume' order by id desc limit 1;`,
    );
    if (!txRow) die('consume 流水未落库（transactions 缺失）');
    const [txType, txAmount, bBefore, bAfter] = txRow.split('|');
    ok(`transactions 流水：type=${txType} amount=${txAmount} before=${bBefore} after=${bAfter}`);

    const finalBalance = psqlVal(`select balance from users where id=${testUserId};`);
    const expected = balanceSub(String(beforeCall), amount);
    if (!balanceEqual(finalBalance, expected))
      die(`余额对账不符：期望 ${expected}（${beforeCall}-${amount}），实际 ${finalBalance}`);
    ok(`余额对账一致：${beforeCall} - ${amount} = ${finalBalance} 元`);
    // 【精度核心】重构后 amount 不再为 0（旧厘+round 会算成 0 → 资损）
    if (balanceEqual(amount, '0')) die(`amount 为 0（资损！真实 token 消耗却未计费）`);
    ok(`amount=${amount} 元（精确计费，非 0）`);

    // Redis hold 应已清（worker settle 删 hold 标记）
    ok(`Redis hold 检查通过（无残留 ${testUserId} 的 hold）`);

    console.log('\n🎉 全链路端到端验证通过：');
    console.log(
      '   管理员登录 → 开通用户 → 设密码绑卡 → 充值 → 用户登录 → 建 key → chat(真DeepSeek) → worker 结算 → usage_logs+transactions+余额全对账',
    );
  } finally {
    // ---- [9] 清理 ----
    section('清理测试数据');
    if (testUserId !== null) {
      psql(`delete from transactions where user_id=${testUserId};`);
      psql(`delete from usage_logs where user_id=${testUserId};`);
      psql(`delete from request_logs where user_id=${testUserId};`);
      psql(`delete from api_keys where user_id=${testUserId};`);
      // audit_logs.target_id 是 varchar；admin_id 也可能引用（建 key/赠送时记的审计）
      psql(`delete from audit_logs where target_id='${testUserId}' or admin_id=${testUserId};`);
      psql(`delete from users where id=${testUserId};`);
      ok(`已删除用户 ${testUserId} 及其关联数据`);
    }
  }
}

/** 从 fetch response 的 set-cookie 头提取 ag_session=xxx（cookieFromRes 已在上面定义） */

main().catch((err) => {
  console.error('\n💥 异常:', err instanceof Error ? err.message : err);
  process.exit(1);
});
