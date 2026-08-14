/**
 * 测试 16：订阅升级/扩容补差价 + 加油包端到端（真实 HTTP，不调上游模型）。
 *
 * 测什么：
 *   1. 建 lite(¥50/¥100额度/层级1) 与 pro(¥150/¥300额度/层级2) 两个包月套餐
 *   2. 用户购买 lite → 余额 500→450
 *   3. 升级到 pro → 剩余额度=100、剩余价值=50、补差价=100 → 余额 450→350，旧订阅到期、新订阅生效
 *   4. 建加油包 pack(¥10/¥15额度)，管理员发放 → 余额 350→355
 *
 * 运行：pnpm tsx scripts/security-audit/16-subscription-change-e2e.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  post,
  psql,
  q,
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

function num(s: string): number {
  return Number(s);
}

async function main(): Promise<void> {
  console.log('🧪 测试 16：订阅升级补差价 + 加油包端到端');
  const admin = await adminCookie();
  const suffix = Date.now();
  let liteId: number | null = null;
  let proId: number | null = null;
  let packId: number | null = null;
  let uid: number | null = null;

  async function createPlan(name: string, price: number, quota: number, sortOrder: number | null, kind: 'subscription' | 'pack'): Promise<number> {
    const res = await post(
      `${ADMIN_API}/api/admin/plans`,
      { name, price, quotaAmount: quota, periodDays: kind === 'pack' ? 0 : 30, kind, sortOrder, fallbackToBalance: true },
      { cookie: admin },
    );
    if (res.status !== 201) throw new Error(`建套餐失败: ${res.status} ${res.raw.slice(0, 300)}`);
    return (res.body as { id: number }).id;
  }

  try {
    section('① 建套餐（lite/pro/加油包）');
    liteId = await createPlan(`E2E-lite-${suffix}`, 50, 100, 1, 'subscription');
    proId = await createPlan(`E2E-pro-${suffix}`, 150, 300, 2, 'subscription');
    packId = await createPlan(`E2E-pack-${suffix}`, 10, 15, null, 'pack');
    green(`lite=${liteId} pro=${proId} pack=${packId}`);

    section('② 建用户 + 购买 lite（余额 500→450）');
    const subject = newSubject('chg-e2e');
    uid = insertUser(subject, '500');
    await setPassword(admin, uid, 'ChgPass123!');
    const login = await userLogin(subject, 'ChgPass123!');
    const buy = await post(`${CLIENT_API}/api/subscriptions`, { planId: liteId, quantity: 1 }, { cookie: login.cookie });
    if (buy.status !== 201) throw new Error(`购买失败: ${buy.status} ${buy.raw.slice(0, 300)}`);
    const sub = buy.body as { subscriptionId: number };
    const balanceAfterBuy = psql(`select balance from users where id=${uid};`);
    green(`已购 lite subscriptionId=${sub.subscriptionId}，余额=${balanceAfterBuy}`);

    section('③ 升级到 pro（补差价 = 150 - 50 = 100，余额 450→350）');
    const change = await post(
      `${CLIENT_API}/api/subscriptions/${sub.subscriptionId}/change`,
      { targetPlanId: proId, quantity: 1 },
      { cookie: login.cookie },
    );
    console.log(`  POST /change → ${change.status} ${JSON.stringify(change.body)}`);
    if (change.status !== 200) throw new Error(`升级失败: ${change.status} ${change.raw.slice(0, 300)}`);
    const balanceAfterChange = psql(`select balance from users where id=${uid};`);
    const newSub = psql(`select plan_id, quantity, status from user_subscriptions where user_id=${uid} order by id desc limit 1;`).split('|');
    console.log(`  余额=${balanceAfterChange} 新订阅 plan=${newSub[0]} qty=${newSub[1]} status=${newSub[2]}`);
    if (Math.abs(num(balanceAfterChange) - 350) > 1e-9) {
      red('升级补差价错误', `期望余额 350，实际 ${balanceAfterChange}`);
    }
    if (newSub[0] !== String(proId)) red('升级后未切到 pro', `新订阅 plan=${newSub[0]}`);
    green(`升级补差价正确：余额 ${balanceAfterChange}、新订阅=pro`);

    section('④ 发放加油包（余额 350→355）');
    const grant = await post(`${ADMIN_API}/api/admin/plans/${packId}/grant`, { userId: uid }, { cookie: admin });
    console.log(`  POST /grant → ${grant.status} ${JSON.stringify(grant.body)}`);
    if (grant.status !== 200) throw new Error(`发放失败: ${grant.status} ${grant.raw.slice(0, 300)}`);
    const balanceAfterPack = psql(`select balance from users where id=${uid};`);
    if (Math.abs(num(balanceAfterPack) - 355) > 1e-9) {
      red('加油包入账错误', `期望余额 355，实际 ${balanceAfterPack}`);
    }
    green(`加油包入账正确：余额 ${balanceAfterPack}`);

    console.log('\n✅ 升级补差价 + 加油包 端到端通过');
  } finally {
    if (uid) cleanupUser(uid);
    for (const id of [packId, proId, liteId]) {
      if (id) {
        const del = await fetch(`${ADMIN_API}/api/admin/plans/${id}`, { method: 'DELETE', headers: { cookie: admin } });
        console.log(`  （清理）删除套餐 id=${id} → ${del.status}`);
      }
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
