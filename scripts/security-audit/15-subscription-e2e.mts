/**
 * 测试 15：包月订阅（套餐）端到端——真实 MiniMax-M3。
 *
 * 测什么：套餐「额度优先、余额兜底、额度永不为负」是否贯通全链路：
 *   1. 管理员建套餐（额度 100 元，fallback 开）
 *   2. 用户用余额购买套餐（扣余额、开订阅）
 *   3. 真实调 MiniMax-M3（费用极小，应被套餐全额覆盖）
 *   4. 等 worker 结算，核对：usage_logs.billedBy='plan'、余额不动、订阅 used_amount 增加
 *
 * 运行：pnpm tsx scripts/security-audit/15-subscription-e2e.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  createKey,
  post,
  patch,
  psql,
  q,
  GATEWAY,
  ADMIN_API,
  CLIENT_API,
  newSubject,
  cleanupUser,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const MODEL = 'MiniMax-M3';
const PLAN_PRICE = '10';
const PLAN_QUOTA = '100';

function num(s: string): number {
  return Number(s);
}

async function main(): Promise<void> {
  console.log('🧪 测试 15：包月订阅端到端（真实 MiniMax-M3）');
  const admin = await adminCookie();
  const planName = `E2E套餐-${Date.now()}`;
  let planId: number | null = null;
  let uid: number | null = null;

  try {
    section('① 管理员建套餐');
    const create = await post(
      `${ADMIN_API}/api/admin/plans`,
      { name: planName, price: Number(PLAN_PRICE), periodDays: 30, quotaAmount: Number(PLAN_QUOTA), fallbackToBalance: true },
      { cookie: admin },
    );
    console.log(`  POST /plans → ${create.status} ${JSON.stringify(create.body)}`);
    if (create.status !== 201) throw new Error(`建套餐失败: ${create.status} ${create.raw.slice(0, 300)}`);
    planId = (create.body as { id: number }).id;
    green(`套餐 id=${planId} 额度=${PLAN_QUOTA} 元`);

    section('② 建用户 + 用余额购买套餐');
    const subject = newSubject('sub-e2e');
    uid = insertUser(subject, '50');
    await setPassword(admin, uid, 'SubPass123!');
    const login = await userLogin(subject, 'SubPass123!');
    const buy = await post(
      `${CLIENT_API}/api/subscriptions`,
      { planId },
      { cookie: login.cookie },
    );
    console.log(`  POST /subscriptions → ${buy.status} ${JSON.stringify(buy.body)}`);
    if (buy.status !== 201) throw new Error(`购买失败: ${buy.status} ${buy.raw.slice(0, 300)}`);
    const sub = buy.body as { subscriptionId: number; balanceAfter: string };
    const balanceAfterBuy = psql(`select balance from users where id=${uid};`);
    green(`已订阅 subscriptionId=${sub.subscriptionId}，购买后余额=${balanceAfterBuy} 元（应=50-10=40）`);

    section('③ 真实调用 MiniMax-M3（应被套餐全额覆盖）');
    const key = await createKey(login.cookie, 'sub-e2e');
    const res = await post(
      `${GATEWAY}/v1/chat/completions`,
      { model: MODEL, messages: [{ role: 'user', content: '只回复两个字：你好' }], max_tokens: 8 },
      { headers: { authorization: `Bearer ${key}` } },
    );
    const requestId = res.headers.get('x-request-id') ?? '';
    console.log(`  chat → ${res.status}，x-request-id=${requestId}`);
    if (res.status !== 200) throw new Error(`chat 失败: ${res.status} ${res.raw.slice(0, 300)}`);

    section('④ 等 worker 结算，核对套餐分流');
    let usage = '';
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      usage = psql(
        `select billed_by, plan_amount, payg_amount, amount from usage_logs where request_id=${q(requestId)} limit 1;`,
      );
      if (usage) break;
    }
    if (!usage) red('套餐结算卡住：20s 无 usage_logs', `request=${requestId}`);
    const [billedBy, planAmount, paygAmount, amount] = usage.split('|');
    console.log(`  usage_logs: billedBy=${billedBy} plan=${planAmount} payg=${paygAmount} amount=${amount}`);
    if (billedBy !== 'plan') {
      red('套餐未全额覆盖', `billedBy=${billedBy}（应为 plan），plan=${planAmount} payg=${paygAmount}`);
    }
    if (num(paygAmount) !== 0) {
      red('套餐覆盖后不应扣余额', `paygAmount=${paygAmount}（应 0）`);
    }

    const subRow = psql(
      `select used_amount, reserved_amount, status from user_subscriptions where id=${sub.subscriptionId};`,
    );
    const [usedAmount, reservedAmount, status] = subRow.split('|');
    console.log(`  subscription: used=${usedAmount} reserved=${reservedAmount} status=${status}`);
    if (num(usedAmount) <= 0) red('订阅 used_amount 未增加', `used=${usedAmount}`);
    if (num(reservedAmount) !== 0) red('订阅在途敞口未释放', `reserved=${reservedAmount}`);

    const balanceNow = psql(`select balance from users where id=${uid};`);
    console.log(`  余额: 购买后=${balanceAfterBuy} 现在=${balanceNow}（应不变，套餐覆盖）`);
    if (Math.abs(num(balanceNow) - num(balanceAfterBuy)) > 1e-9) {
      red('套餐覆盖时余额被扣了', `购买后=${balanceAfterBuy} 现在=${balanceNow}`);
    }

    green(`套餐端到端通过：billedBy=plan、套餐扣 used=${usedAmount} 元、余额不动、reserved 归 0`);
  } finally {
    // 先清用户（含其订阅），再删套餐，避免 FK 依赖
    if (uid) cleanupUser(uid);
    if (planId) {
      const del = await fetch(`${ADMIN_API}/api/admin/plans/${planId}`, { method: 'DELETE', headers: { cookie: admin } });
      console.log(`  （清理）删除套餐 id=${planId} → ${del.status}`);
    }
    console.log('（测试账号与套餐已清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
