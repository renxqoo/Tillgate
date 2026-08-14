/**
 * 测试 17：订阅即闸门 + 纯额度 + 席位=Key 名额 —— 全链路 E2E（mock 上游，数据保留）。
 *
 * 覆盖：
 *   个人：无订阅建Key→402；买lite；建1Key成功、第2Key→409；调用→扣套餐额度不动余额；
 *        个人买企业套餐→403；升级lite→pro；额度尽→402；到期→402；续费→额度重置。
 *   企业：买Pro×3；建3Key、第4Key→409；调用→扣额度不动余额；升级Pro→MAX；加油包加额度。
 *   加油包：无订阅→拒绝。
 *
 * 运行前：node scripts/security-audit/mock-upstream.mjs 9999（mock 上游）
 * 运行：pnpm tsx scripts/security-audit/17-subscription-billing-e2e.mts
 * 说明：本脚本「保留」所有测试数据（不清理），结束时打印账号清单。
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
  CLIENT_API,
  ADMIN_API,
  newSubject,
} from './helpers.mts';

loadEnv();

const MODEL = 'fb-main-1786677137115-oov0'; // 复用已有 mock 上游映射（→ localhost:9999）

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? `  → ${detail}` : ''}`);
  }
}
const section = (t: string): void => console.log(`\n━━━ ${t} ━━━`);
const num = (s: string): number => Number(s);

function planId(name: string): number {
  const id = Number(psql(`select id from plans where name=${q(name)} and status=0 order by id desc limit 1;`));
  if (!Number.isFinite(id) || id <= 0) throw new Error(`plan「${name}」不存在`);
  return id;
}

function subState(subscriptionId: number): { quota: number; used: number; reserved: number; quantity: number; status: number; endAt: string } {
  const row = psql(
    `select quota_amount, used_amount, reserved_amount, quantity, status, end_at from user_subscriptions where id=${subscriptionId};`,
  );
  const [quota, used, reserved, quantity, status, endAt] = row.split('|');
  return { quota: num(quota), used: num(used), reserved: num(reserved), quantity: num(quantity), status: num(status), endAt };
}

async function gatewayCall(key: string, maxTokens = 500): Promise<{ status: number; body: any; requestId: string }> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: maxTokens },
    { headers: { authorization: `Bearer ${key}` } },
  );
  return { status: res.status, body: res.body, requestId: res.headers.get('x-request-id') ?? '' };
}

/** 等 worker 结算出 usage_logs，返回 "billed_by|plan_amount|payg_amount|amount" */
async function pollUsage(requestId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const u = psql(`select billed_by, plan_amount, payg_amount, amount from usage_logs where request_id=${q(requestId)} limit 1;`);
    if (u) return u;
  }
  return '';
}

async function makeUser(label: string, balance: string, isEnterprise = false): Promise<{ subject: string; password: string; uid: number; cookie: string }> {
  const subject = newSubject(`e2e17-${label}`);
  const password = 'E2ePass123!';
  const uid = insertUser(subject, balance);
  if (isEnterprise) psql(`update users set is_enterprise=true where id=${uid};`);
  const admin = await adminCookie();
  await setPassword(admin, uid, password);
  const login = await userLogin(subject, password);
  console.log(`  建${isEnterprise ? '企业' : '个人'}用户 ${subject}（id=${uid}，余额=${balance}）`);
  return { subject, password, uid, cookie: login.cookie };
}

async function main(): Promise<void> {
  console.log('🧪 测试 17：订阅即闸门 + 纯额度 + 席位=Key 名额（mock 上游）');
  const admin = await adminCookie();
  const liteId = planId('lite');
  const proId = planId('pro');
  const ProId = planId('Pro');
  const MAXId = planId('MAX');
  console.log(`  套餐: lite=${liteId} pro=${proId} Pro=${ProId} MAX=${MAXId}`);

  // ── ① 个人用户 ─────────────────────────────────────────────
  section('① 个人用户：无订阅 → 建 Key 拒绝');
  const person = await makeUser('person', '1000');
  const noSubKey = await post(`${CLIENT_API}/api/keys`, { name: 'x' }, { cookie: person.cookie });
  check(noSubKey.status === 402 && (noSubKey.body as any)?.error?.code === 'SUBSCRIPTION_REQUIRED', '无订阅建 Key → 402', `status=${noSubKey.status}`);

  section('② 个人：购买 lite（¥50，额度¥50）');
  const buyLite = await post(`${CLIENT_API}/api/subscriptions`, { planId: liteId }, { cookie: person.cookie });
  check(buyLite.status === 201, '购买 lite → 201', `status=${buyLite.status} ${JSON.stringify(buyLite.body)}`);
  const liteSub = (buyLite.body as any)?.subscriptionId as number;
  const liteBalance = num(psql(`select balance from users where id=${person.uid};`));
  check(Math.abs(liteBalance - 950) < 1e-9, '余额 1000 → 950（扣 ¥50）', `balance=${liteBalance}`);
  check((buyLite.body as any)?.quantity === 1, '个人套餐 quantity=1', `quantity=${(buyLite.body as any)?.quantity}`);

  section('③ 个人：席位=Key 名额（1 席）');
  const personKey = await createKey(person.cookie, 'person-key');
  check(!!personKey, '建第 1 个 Key → 成功');
  const key2 = await post(`${CLIENT_API}/api/keys`, { name: 'x' }, { cookie: person.cookie });
  check(key2.status === 409 && (key2.body as any)?.error?.code === 'SEATS_FULL', '建第 2 个 Key → 409 SEATS_FULL', `status=${key2.status} code=${(key2.body as any)?.error?.code}`);

  section('④ 个人：调用扣套餐额度，不动余额');
  const balBefore = num(psql(`select balance from users where id=${person.uid};`));
  const usedBefore = subState(liteSub).used;
  const call1 = await gatewayCall(personKey);
  check(call1.status === 200, 'gateway 调用 → 200', `status=${call1.status} ${JSON.stringify(call1.body).slice(0, 160)}`);
  if (call1.requestId) {
    const usage = await pollUsage(call1.requestId);
    const [billedBy, planAmount, paygAmount] = usage ? usage.split('|') : ['', '', ''];
    console.log(`  usage_logs: billedBy=${billedBy} plan=${planAmount} payg=${paygAmount}`);
    check(billedBy === 'plan', 'billedBy=plan', `billedBy=${billedBy}`);
    check(paygAmount !== '' && num(paygAmount) === 0, 'paygAmount=0（未扣余额）', `payg=${paygAmount}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  const usedAfter = subState(liteSub).used;
  const balAfter = num(psql(`select balance from users where id=${person.uid};`));
  check(usedAfter > usedBefore, '订阅 used_amount 增加（额度被扣）', `used ${usedBefore} → ${usedAfter}`);
  check(Math.abs(balAfter - balBefore) < 1e-9, '余额不变（不扣余额）', `balance ${balBefore} → ${balAfter}`);

  section('⑤ 个人（无订阅）：买企业套餐 → 403');
  const noEntUser = await makeUser('noent', '500');
  const buyPro = await post(`${CLIENT_API}/api/subscriptions`, { planId: ProId }, { cookie: noEntUser.cookie });
  check(buyPro.status === 403 && (buyPro.body as any)?.error?.code === 'ENTERPRISE_REQUIRED', '个人买 Pro → 403 ENTERPRISE_REQUIRED', `status=${buyPro.status} code=${(buyPro.body as any)?.error?.code}`);

  section('⑥ 个人：升级 lite → pro（补差价）');
  const upLite = await post(`${CLIENT_API}/api/subscriptions/${liteSub}/change`, { targetPlanId: proId, quantity: 1 }, { cookie: person.cookie });
  check(upLite.status === 200, '升级 lite→pro → 200', `status=${upLite.status} ${JSON.stringify(upLite.body)}`);
  const upBody = upLite.body as any;
  check(upBody?.planId === proId, '升级后 planId=pro', `planId=${upBody?.planId}`);
  console.log(`  升级结果: 新订阅=${upBody?.subscriptionId} 补差价后余额=${upBody?.balanceAfter}`);

  // ── ② 企业用户 ─────────────────────────────────────────────
  section('⑦ 企业用户：买 Pro×3 席位');
  const ent = await makeUser('ent', '2000', true);
  const buyProEnt = await post(`${CLIENT_API}/api/subscriptions`, { planId: ProId, quantity: 3 }, { cookie: ent.cookie });
  check(buyProEnt.status === 201, '企业买 Pro×3 → 201', `status=${buyProEnt.status} ${JSON.stringify(buyProEnt.body)}`);
  const entSub = (buyProEnt.body as any)?.subscriptionId as number;
  check((buyProEnt.body as any)?.quantity === 3, 'quantity=3', `quantity=${(buyProEnt.body as any)?.quantity}`);

  section('⑧ 企业：席位=Key 名额（3 席）');
  const entKeys: string[] = [];
  for (let i = 1; i <= 3; i++) entKeys.push(await createKey(ent.cookie, `ent-key-${i}`));
  const activeCount = num(psql(`select count(*) from api_keys where user_id=${ent.uid} and status=0;`));
  check(activeCount === 3, '建 3 个 Key → 成功', `active=${activeCount}`);
  const key4 = await post(`${CLIENT_API}/api/keys`, { name: 'x' }, { cookie: ent.cookie });
  check(key4.status === 409 && (key4.body as any)?.error?.code === 'SEATS_FULL', '第 4 个 Key → 409 SEATS_FULL', `status=${key4.status} code=${(key4.body as any)?.error?.code}`);

  section('⑨ 企业：调用扣套餐额度，不动余额');
  const entQuota = subState(entSub).quota;
  check(entQuota === 450, 'Pro×3 总额度 = 150×3 = 450', `quota=${entQuota}`);
  const entCallBalBefore = num(psql(`select balance from users where id=${ent.uid};`));
  const entUsedBefore = subState(entSub).used;
  const entCall = await gatewayCall(entKeys[0]!);
  check(entCall.status === 200, '企业 gateway 调用 → 200', `status=${entCall.status}`);
  if (entCall.requestId) {
    const usage = await pollUsage(entCall.requestId);
    const [billedBy, , paygAmount] = usage ? usage.split('|') : ['', '', ''];
    check(billedBy === 'plan', '企业 billedBy=plan', `billedBy=${billedBy}`);
    check(paygAmount !== '' && num(paygAmount) === 0, '企业 paygAmount=0', `payg=${paygAmount}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  const entUsedAfter = subState(entSub).used;
  const entCallBalAfter = num(psql(`select balance from users where id=${ent.uid};`));
  check(entUsedAfter > entUsedBefore, '企业订阅 used 增加', `used ${entUsedBefore} → ${entUsedAfter}`);
  check(Math.abs(entCallBalAfter - entCallBalBefore) < 1e-9, '企业余额不变', `balance ${entCallBalBefore} → ${entCallBalAfter}`);

  section('⑩ 企业：升级 Pro → MAX（补差价）');
  const upEnt = await post(`${CLIENT_API}/api/subscriptions/${entSub}/change`, { targetPlanId: MAXId, quantity: 3 }, { cookie: ent.cookie });
  check(upEnt.status === 200, '升级 Pro→MAX → 200', `status=${upEnt.status} ${JSON.stringify(upEnt.body)}`);
  check((upEnt.body as any)?.planId === MAXId, '升级后 planId=MAX', `planId=${(upEnt.body as any)?.planId}`);
  const entNewSub = (upEnt.body as any)?.subscriptionId as number;

  section('⑪ 加油包：加订阅额度');
  // 建一个 pack（加油包）
  const packName = `e2e17-pack-${Date.now()}`;
  const packRes = await post(`${ADMIN_API}/api/admin/plans`, { name: packName, kind: 'pack', price: 10, quotaAmount: 15, periodDays: 0 }, { cookie: admin });
  const packId = (packRes.body as any)?.id as number;
  check(packRes.status === 201, '建加油包 → 201', `status=${packRes.status}`);
  const entBalBefore = num(psql(`select balance from users where id=${ent.uid};`));
  const entQuotaBefore = subState(entNewSub).quota;
  const grant = await post(`${ADMIN_API}/api/admin/plans/${packId}/grant`, { userId: ent.uid }, { cookie: admin });
  check(grant.status === 200, '发放加油包 → 200', `status=${grant.status} ${JSON.stringify(grant.body)}`);
  const entQuotaAfter = subState(entNewSub).quota;
  const entBalAfter = num(psql(`select balance from users where id=${ent.uid};`));
  check(entQuotaAfter > entQuotaBefore, '订阅额度增加', `quota ${entQuotaBefore} → ${entQuotaAfter}`);
  check(Math.abs(entBalBefore - entBalAfter - 10) < 1e-9, '余额扣售价 ¥10', `balance ${entBalBefore} → ${entBalAfter}`);

  section('⑫ 加油包：无订阅 → 拒绝');
  const noSubUser = await makeUser('nosub', '100');
  const grantNoSub = await post(`${ADMIN_API}/api/admin/plans/${packId}/grant`, { userId: noSubUser.uid }, { cookie: admin });
  check(grantNoSub.status === 404 || grantNoSub.status === 400, '无订阅发放加油包 → 拒绝', `status=${grantNoSub.status} ${JSON.stringify(grantNoSub.body)}`);

  // ── ③ 到期 / 额度尽 ───────────────────────────────────────
  section('⑬ 到期：Key 不吊销、调用 → 402 subscription_required');
  const expUser = await makeUser('expired', '500');
  const expBuy = await post(`${CLIENT_API}/api/subscriptions`, { planId: liteId }, { cookie: expUser.cookie });
  const expSub = (expBuy.body as any)?.subscriptionId as number;
  const expKey = await createKey(expUser.cookie, 'exp-key');
  psql(`update user_subscriptions set end_at = now() - interval '1 day' where id=${expSub};`);
  const expCall = await gatewayCall(expKey);
  check(expCall.status === 402 && expCall.body?.error?.code === 'subscription_required', '到期调用 → 402 subscription_required', `status=${expCall.status} code=${expCall.body?.error?.code}`);
  const expKeyStatus = num(psql(`select status from api_keys where user_id=${expUser.uid} limit 1;`));
  check(expKeyStatus === 0, '到期后 Key 未被吊销（status=0）', `key status=${expKeyStatus}`);

  section('⑭ 额度尽：调用 → 402 subscription_quota_exhausted');
  const lowUser = await makeUser('lowquota', '500');
  const lowBuy = await post(`${CLIENT_API}/api/subscriptions`, { planId: liteId }, { cookie: lowUser.cookie });
  const lowSub = (lowBuy.body as any)?.subscriptionId as number;
  const lowKey = await createKey(lowUser.cookie, 'low-key');
  psql(`update user_subscriptions set quota_amount='0.5', used_amount='0', reserved_amount='0' where id=${lowSub};`);
  const lowCall = await gatewayCall(lowKey);
  check(lowCall.status === 402 && lowCall.body?.error?.code === 'subscription_quota_exhausted', '额度尽调用 → 402 subscription_quota_exhausted', `status=${lowCall.status} code=${lowCall.body?.error?.code}`);

  section('⑮ 续费：额度重置、旧订阅到期');
  const renewUser = await makeUser('renew', '500');
  const renewBuy = await post(`${CLIENT_API}/api/subscriptions`, { planId: liteId }, { cookie: renewUser.cookie });
  const renewSub = (renewBuy.body as any)?.subscriptionId as number;
  psql(`update user_subscriptions set used_amount='30', quota_amount='50' where id=${renewSub};`);
  const renewRes = await post(`${CLIENT_API}/api/subscriptions/${renewSub}/renew`, {}, { cookie: renewUser.cookie });
  check(renewRes.status === 200, '续费 → 200', `status=${renewRes.status} ${JSON.stringify(renewRes.body)}`);
  const renewNewSub = (renewRes.body as any)?.subscriptionId as number;
  const renewState = subState(renewNewSub);
  check(renewState.used === 0 && renewState.reserved === 0, '续费后新订阅 used=0/reserved=0', `used=${renewState.used} reserved=${renewState.reserved}`);
  const oldSubStatus = num(psql(`select status from user_subscriptions where id=${renewSub};`));
  check(oldSubStatus === 1, '旧订阅转到期(status=1)', `status=${oldSubStatus}`);

  console.log('\n════════════════════════════════════════');
  console.log(`测试结果：${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
  console.log('保留的测试账号（密码均为 E2ePass123!）：');
  console.log(`  个人: ${person.subject}（id=${person.uid}）`);
  console.log(`  企业: ${ent.subject}（id=${ent.uid}）`);
  console.log(`  到期: ${expUser.subject}（id=${expUser.uid}）`);
  console.log(`  额度尽: ${lowUser.subject}（id=${lowUser.uid}）`);
  console.log(`  续费: ${renewUser.subject}（id=${renewUser.uid}）`);
  console.log(`  无订阅: ${noSubUser.subject}（id=${noSubUser.uid}）`);
  console.log(`  个人无订阅(买企业拒): ${noEntUser.subject}（id=${noEntUser.uid}）`);
  console.log('════════════════════════════════════════');
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
