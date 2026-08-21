/**
 * 22 · 第三轮攻击实弹验证（T1/T2/T3/T4 缺陷复现，RED）
 *
 * T1【高】幂等键命名空间投毒：client 可发任意 `idempotency-key` 头（无字符集/长度校验），
 *   与系统自然键（signup-gift:{userId} 等）共享 fund_operations.operationId 全局主键。
 *   攻击者用 `idempotency-key: signup-gift:<受害者id>` 完成一次购买 → 该键被永久占用 →
 *   受害者首次登录 grantSignupGift 撞主键 → idempotency_conflict 未捕获 → 登录 500 永久锁死。
 * T1b 超长幂等键（>128）→ PG 22001 → 500（应 400）。
 * T3【中】席位（团队套餐）购买：org 创建在账本事务外 → 同幂等键重放 = 第二个 org +
 *   fingerprint 不一致 → 409（幂等性完全失效）+ 孤儿 org 刷行。
 * T4【中】/oauth/token client_id 无长度校验：1MB client_id 未被拒绝（应 400），
 *   且作为 Redis 键落库（oauth_attempts:{1MB}）。
 *
 * 按指示不清理数据，账号留档 ACCOUNTS-3.md。修复后本脚本应 exit 0。
 */
import { execSync } from 'node:child_process';
import {
  loadEnv,
  psql,
  insertUser,
  setPassword,
  adminCookie,
  userLogin,
  post,
  CLIENT_API,
  GATEWAY,
  newSubject,
} from './helpers.mts';

loadEnv();

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}

async function main(): Promise<void> {
  // ── 准备：受害者（未登录新号）+ 攻击者 ──
  const victimSubject = newSubject('poison-victim');
  const victimId = insertUser(victimSubject, '0');
  const attackerSubject = newSubject('poisoner');
  const attackerId = insertUser(attackerSubject, '50'); // 够买最便宜套餐
  await setPassword(await adminCookie(), attackerId, 'Poisoner123!');
  const { cookie: attackerCookie } = await userLogin(attackerSubject, 'Poisoner123!');
  console.log(`[setup] 受害者 id=${victimId}（未登录），攻击者 id=${attackerId}`);

  // 挑一个最便宜的上架正价套餐
  const plans = psql(
    `select id, price::numeric(12,2), quota_amount::numeric(12,2), allow_seats from plans where status=0 and kind='subscription' and price>0 order by price asc limit 1;`,
  );
  const [planId, planPrice] = plans.split('|');
  console.log(`[setup] 目标套餐 id=${planId} price=${planPrice}`);
  if (Number(planPrice) > 50) {
    console.log('[setup] 最便宜套餐超过攻击者余额，跳过 T1（余额不足无法投毒）');
  }

  // ── T1：投毒 signup-gift:{victimId} ──
  if (Number(planPrice) <= 50) {
    const poisonRes = await post(
      `${CLIENT_API}/api/subscriptions`,
      { planId: Number(planId) },
      { cookie: attackerCookie, headers: { 'idempotency-key': `signup-gift:${victimId}` } },
    );
    console.log(`[T1] 攻击者用投毒键购买 → ${poisonRes.status} ${poisonRes.raw.slice(0, 160)}`);
    const burned = psql(
      `select kind from fund_operations where operation_id='signup-gift:' || ${victimId};`,
    );
    console.log(`[T1] fund_operations 里该键的 kind=${burned || '（未占用）'}`);

    await setPassword(await adminCookie(), victimId, 'Victim123!');
    const loginRes = await post(`${CLIENT_API}/api/auth/login`, {
      username: victimSubject,
      password: 'Victim123!',
    });
    check(
      'T1 受害者登录不被投毒键影响（应为 200）',
      loginRes.status === 200,
      `登录 → ${loginRes.status} ${loginRes.raw.slice(0, 140)}`,
    );
  }

  // ── T1b：超长幂等键 ──
  const longKey = 'K'.repeat(200);
  const longRes = await post(
    `${CLIENT_API}/api/subscriptions`,
    { planId: Number(planId) },
    { cookie: attackerCookie, headers: { 'idempotency-key': longKey } },
  );
  check(
    'T1b 超长幂等键应 400 而非 500',
    longRes.status === 400 || longRes.status === 409 || longRes.status === 402,
    `→ ${longRes.status} ${longRes.raw.slice(0, 120)}`,
  );

  // ── T3：席位购买幂等性（需要企业用户 + seats 套餐 + 余额）──
  const seatsPlan = psql(
    `select id, price::numeric(12,2) from plans where status=0 and kind='subscription' and allow_seats and price>0 order by price asc limit 1;`,
  );
  if (seatsPlan) {
    const [spId, spPrice] = seatsPlan.split('|');
    const entSubject = newSubject('seatsreplay');
    const entId = insertUser(entSubject, '1000');
    await setPassword(await adminCookie(), entId, 'SeatsReplay123!');
    // 标记企业用户
    psql(`update users set is_enterprise=true where id=${entId};`);
    const { cookie: entCookie } = await userLogin(entSubject, 'SeatsReplay123!');
    const key = `seats-replay-${Date.now()}`;
    const buy1 = await post(
      `${CLIENT_API}/api/subscriptions`,
      { planId: Number(spId), quantity: 2 },
      { cookie: entCookie, headers: { 'idempotency-key': key } },
    );
    const orgCount1 = psql(`select count(*) from organizations where owner_user_id=${entId};`);
    const buy2 = await post(
      `${CLIENT_API}/api/subscriptions`,
      { planId: Number(spId), quantity: 2 },
      { cookie: entCookie, headers: { 'idempotency-key': key } },
    );
    const orgCount2 = psql(`select count(*) from organizations where owner_user_id=${entId};`);
    console.log(`[T3] 首购=${buy1.status} 重放=${buy2.status} ${buy2.raw.slice(0, 140)}`);
    const replayed = (buy2.body as { replayed?: boolean }).replayed;
    check(
      'T3 席位购买同幂等键重放应 replayed=true 且不新增 org',
      (buy2.status === 200 || buy2.status === 201) && replayed === true && orgCount1 === orgCount2,
      `首购=${buy1.status} 重放=${buy2.status} replayed=${String(replayed)} org数 ${orgCount1}→${orgCount2}`,
    );
  } else {
    console.log('[T3] 无上架席位套餐，跳过');
  }

  // ── T4：/oauth/token 巨型 client_id ──
  const hugeId = 'A'.repeat(1024 * 1024); // 1MB（bodyLimit 16MB 内）
  const oauthRes = await post(`${GATEWAY}/oauth/token`, {
    grant_type: 'client_credentials',
    client_id: hugeId,
    client_secret: 'x',
  });
  check(
    'T4 1MB client_id 应被 400 拒绝（长度校验）',
    oauthRes.status === 400,
    `→ ${oauthRes.status} ${oauthRes.raw.slice(0, 120)}`,
  );
  const redisKeys = execSync(
    `redis-cli -a root123 --scan --pattern 'oauth_attempts:AAA*' | head -1`,
    { encoding: 'utf8' },
  ).trim();
  check('T4b 巨型 client_id 不得落入 Redis 键', redisKeys === '', redisKeys ? `出现 ${redisKeys.slice(0, 40)}…` : '无');

  console.log(`\n账号留档：victim=${victimId} attacker=${attackerId}`);
  if (reds > 0) {
    console.error(`\n[RED] ${reds} 项缺陷复现`);
    process.exit(1);
  }
  console.log('\n[GREEN] 全部通过');
}

main().catch((e) => {
  console.error(`脚本异常：${e}`);
  process.exit(1);
});
