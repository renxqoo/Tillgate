/**
 * 18 · 零价套餐自助订阅薅羊毛（资损，RED）
 *
 * 缺陷：packages/ledger/src/ledger.ts applySubscription 闸门只校验
 *   plan.status/kind/席位/企业标志，没有「price>0 或显式免费标志」的校验；
 *   余额闸门 `balance - reserved >= price` 对 price=0 恒真。
 *   任何登录用户可自助订阅 DB 中 status=0 且 price=0 的套餐（当前库有 96 个，
 *   含 loadtest-plan：¥0 / 额度 ¥1,000,000,000 / 3650 天），白得额度并可
 *   1:1 转换为平台承担的上游真实开销。
 *
 * 攻击链（真实服务 + 真实用户）：
 *   开号 → 登录 → GET /api/plans 挑 ¥0 套餐 → POST /api/subscriptions →
 *   建绑定订阅的 Key → 网关真实调用（deepseek-v4-flash，极小 max_tokens 证明变现）。
 *
 * 按指示：本脚本【不清理】任何测试数据，账号与订阅全部保留供人工核查
 * （记录见 scripts/security-audit/ACCOUNTS-2.md）。
 *
 * 期望（修复后）：POST /api/subscriptions 对 price=0 套餐返回 4xx，脚本 exit 0。
 * 当前：订阅成功（201），脚本在断言处 exit 1（RED）。
 */
import {
  loadEnv,
  psql,
  q,
  insertUser,
  setPassword,
  adminCookie,
  userLogin,
  get,
  post,
  GATEWAY,
  CLIENT_API,
  newSubject,
} from './helpers.mts';

loadEnv();

interface PlanRow {
  id: number;
  name: string;
  price: string;
  quota: string;
  status: number;
}

function fail(msg: string): never {
  console.error(`\n[RED] ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const subject = newSubject('freeload');
  const password = 'FreeLoad123!';

  // 1) 造号 + 开通 + 登录（新用户首登会发 ¥1 礼金——与漏洞无关，price=0 不看余额）
  const userId = insertUser(subject, '0');
  await setPassword(await adminCookie(), userId, password);
  const { cookie } = await userLogin(subject, password);
  console.log(`[1] 新用户 ${subject} (id=${userId}) 登录成功`);

  // 2) 用户侧套餐列表里挑一个上架中的 ¥0 套餐
  const plansRes = await get(`${CLIENT_API}/api/plans`, { cookie });
  if (plansRes.status !== 200) fail(`GET /api/plans 失败：${plansRes.status} ${plansRes.raw}`);
  const listed = (plansRes.body as { list?: PlanRow[] }).list ?? [];
  const freePlan = listed.find((p) => Number(p.price) === 0);
  console.log(
    `[2] /api/plans 共 ${listed.length} 个可购套餐，其中 ¥0 的 ${listed.filter((p) => Number(p.price) === 0).length} 个`,
  );
  if (!freePlan) {
    console.log('[2] 用户侧没有 ¥0 套餐可薅（当前库数据下不成立），跳过');
    return;
  }
  console.log(
    `[2] 选中目标套餐 id=${freePlan.id} name=${freePlan.name} price=${freePlan.price} quota=${freePlan.quota}`,
  );

  // 3) 【攻击核心】余额 ¥0（含礼金也才 ¥1）自助订阅 ¥0 套餐
  const subRes = await post(`${CLIENT_API}/api/subscriptions`, { planId: freePlan.id }, { cookie });
  console.log(`[3] POST /api/subscriptions → ${subRes.status} ${subRes.raw.slice(0, 300)}`);
  if (subRes.status !== 201) {
    console.log('[GREEN] 零价套餐被拒绝，漏洞已修复');
    return;
  }
  const subId = Number((subRes.body as { subscriptionId?: number }).subscriptionId);
  const subRow = psql(
    `select id, quota_amount, price, status from user_subscriptions where id=${subId};`,
  );
  console.log(`[3] 订阅已建立：${subRow}`);
  console.log(psql(`select balance, reserved_balance from users where id=${userId};`));

  // 4) 建绑定该订阅的 Key（走套餐额度，不动余额）
  const keyRes = await post(
    `${CLIENT_API}/api/keys`,
    { name: 'freeload-key', subscriptionId: subId },
    { cookie },
  );
  if (keyRes.status !== 201) fail(`建 Key 失败：${keyRes.status} ${keyRes.raw}`);
  const key = (keyRes.body as { key: string }).key;
  console.log(`[4] 绑定订阅的 Key 已创建 (key_id=${(keyRes.body as { id: number }).id})`);

  // 5) 真实调用上游（deepseek-v4-flash，max_tokens=8，成本 ~¥0.0001，证明免费额度可变现为平台真金白银）
  const chatRes = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: 'deepseek-v4-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { headers: { authorization: `Bearer ${key}` } },
  );
  console.log(`[5] 网关调用 deepseek-v4-flash → ${chatRes.status}`);
  if (chatRes.status !== 200) {
    console.log(`[5] body: ${chatRes.raw.slice(0, 300)}`);
  }

  // 6) 对账：订阅额度、用量、平台渠道开销
  const after = psql(
    `select (select quota_amount::numeric(20,2) from user_subscriptions where id=${subId}) as quota, ` +
      `(select used_amount::numeric(20,8) from user_subscriptions where id=${subId}) as used, ` +
      `(select balance::numeric(20,4) from users where id=${userId}) as user_balance, ` +
      `(select coalesce(sum(upstream_cost),0)::numeric(20,8) from usage_logs where subscription_id=${subId}) as platform_cost;`,
  );
  console.log(`[6] 对账 ${after}`);

  fail(
    `用户 ${subject}(id=${userId}) 用 ¥${psql(`select balance::numeric(12,4) from users where id=${userId};`)} 余额 ` +
      `白得了套餐 id=${subId} 额度 ${freePlan.quota} 元，且已真实消耗平台上游资金（见上方 platform_cost）。` +
      `修复方向：applySubscription 拒绝 price<=0（或引入显式免费套餐标志 + 管理员审批）。`,
  );
}

main().catch((e) => fail(`脚本异常：${e}`));
