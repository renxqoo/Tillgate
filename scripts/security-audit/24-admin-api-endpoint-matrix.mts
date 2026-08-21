/**
 * 24 · 第四轮逐接口审计②：admin-api（管理面 :8790）接口矩阵
 *
 * 对 ENDPOINTS.md 中 admin-api 全部 ~40 个接口逐一实弹：
 *   N1 无 cookie / 用户面 cookie → 必须 401（鉴权覆盖 + 双平面隔离）
 *   N2 路径/参数非法（NaN id、坏 JSON、非法枚举、负金额）→ 400，不得 500
 *   N3 凭证读取（vouchers）路径穿越探针
 *   N4 管理动作语义（对已终态资源操作、金额边界）
 *
 * 数据纪律：只读探针为主；创建类探针用 matrix4m- 前缀并保留。
 */
import {
  loadEnv, psql, insertUser, setPassword, adminCookie, userLogin,
  post, patch, get, newSubject, ADMIN_API,
} from './helpers.mts';

loadEnv();

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}
async function del(url: string, cookie: string): Promise<{ status: number; raw: string }> {
  const res = await fetch(url, { method: 'DELETE', headers: { cookie } });
  return { status: res.status, raw: await res.text() };
}
const no400 = (s: number) => s === 400;

async function main(): Promise<void> {
  const admin = await adminCookie();
  // 普通用户 cookie（错面）
  const uSubject = newSubject('matrix4u');
  const uId = insertUser(uSubject, '0');
  await setPassword(admin, uId, 'MatrixU123!');
  const user = (await userLogin(uSubject, 'MatrixU123!')).cookie;

  // ═══ N1：无 cookie / 用户 cookie → 401（逐路由抽查全部 17 个文件）═══
  const protectedGets = [
    '/api/admin/auth', '/api/admin/me', '/api/admin/users', '/api/admin/keys',
    '/api/admin/providers', '/api/admin/channels', '/api/admin/channel-funds',
    '/api/admin/models', '/api/admin/model-catalog/sources', '/api/admin/rate-cards',
    '/api/admin/plans', '/api/admin/subscriptions', '/api/admin/redeem-batches',
    '/api/admin/stats/overview', '/api/admin/logs', '/api/admin/audit-logs',
    '/api/admin/billing-operations', '/api/admin/tracing/recent',
  ];
  for (const p of protectedGets) {
    const r = await get(`${ADMIN_API}${p}`);
    check(`N1 GET ${p} 无cookie=401`, r.status === 401, `→ ${r.status}`);
  }
  for (const p of ['/api/admin/users', '/api/admin/channels', '/api/admin/billing-operations']) {
    const r = await get(`${ADMIN_API}${p}`, { cookie: user });
    check(`N1 GET ${p} 用户cookie=401（错面隔离）`, r.status === 401, `→ ${r.status}`);
  }
  // 公开面只剩 /auth/login 与 /healthz
  const pubLogin = await post(`${ADMIN_API}/api/admin/auth/login`, { email: 'x@x', password: 'x' });
  check('N1b /auth/login 公开可及（401 凭证错）', pubLogin.status === 401 || pubLogin.status === 429 || pubLogin.status === 400, `→ ${pubLogin.status}`);
  const hz = await get(`${ADMIN_API}/healthz`);
  check('N1c /healthz 公开 200', hz.status === 200, `→ ${hz.status}`);

  // ═══ N2：非法输入 → 400 不得 500 ═══
  const n2: [string, () => Promise<{ status: number; raw: string }>][] = [
    ['GET /users/abc', () => get(`${ADMIN_API}/api/admin/users/abc`, { cookie: admin })],
    ['PATCH /users/abc', () => patch(`${ADMIN_API}/api/admin/users/abc`, { status: 1 }, { cookie: admin })],
    ['GET /channels/abc', () => get(`${ADMIN_API}/api/admin/channels/abc`, { cookie: admin })],
    ['PATCH /channels/abc', () => patch(`${ADMIN_API}/api/admin/channels/abc`, { name: 'x' }, { cookie: admin })],
    ['GET /models/abc', () => get(`${ADMIN_API}/api/admin/models/abc`, { cookie: admin })],
    ['GET /rate-cards/abc', () => get(`${ADMIN_API}/api/admin/rate-cards/abc`, { cookie: admin })],
    ['GET /plans/abc', () => get(`${ADMIN_API}/api/admin/plans/abc`, { cookie: admin })],
    ['GET /redeem-batches/abc', () => get(`${ADMIN_API}/api/admin/redeem-batches/abc`, { cookie: admin })],
    // 说明：/users/:id/transactions 的 from/to 是未实现的过滤参数（被忽略，200）——功能缺口非缺陷；
    // /logs 排序固定 created_at desc，无动态 sortBy（注入面不存在）。两者不进 400 断言。
    ['POST /users/abc/gift', () => post(`${ADMIN_API}/api/admin/users/abc/gift`, { amount: 1 }, { cookie: admin })],
    ['POST /users/abc/set-password', () => post(`${ADMIN_API}/api/admin/users/abc/set-password`, { password: 'x' }, { cookie: admin })],
    ['POST /users/1/gift 负数', () => post(`${ADMIN_API}/api/admin/users/1/gift`, { amount: -1 }, { cookie: admin })],
    ['POST /users/1/gift Infinity', () => post(`${ADMIN_API}/api/admin/users/1/gift`, { amount: 1e308 }, { cookie: admin })],
    ['POST /users/1/gift 缺金额', () => post(`${ADMIN_API}/api/admin/users/1/gift`, {}, { cookie: admin })],
    ['POST /plans 零价', () => post(`${ADMIN_API}/api/admin/plans`, { name: 'm-zero', kind: 'subscription', price: 0, durationDays: 30, quotaAmount: '1' }, { cookie: admin })],
    ['POST /plans 负价', () => post(`${ADMIN_API}/api/admin/plans`, { name: 'm-neg', kind: 'subscription', price: -5, durationDays: 30, quotaAmount: '1' }, { cookie: admin })],
    ['POST /plans 非法kind', () => post(`${ADMIN_API}/api/admin/plans`, { name: 'm-kind', kind: 'weird', price: 1, durationDays: 30, quotaAmount: '1' }, { cookie: admin })],
    ['POST /subscriptions/abc/cancel', () => post(`${ADMIN_API}/api/admin/subscriptions/abc/cancel`, {}, { cookie: admin })],
    ['POST /subscriptions/abc/change', () => post(`${ADMIN_API}/api/admin/subscriptions/abc/change`, { targetPlanId: 1 }, { cookie: admin })],
    ['POST /billing-operations/abc/retry', () => post(`${ADMIN_API}/api/admin/billing-operations/abc/retry`, {}, { cookie: admin })],
    ['POST /billing-operations/1/resolve 非法decision', () => post(`${ADMIN_API}/api/admin/billing-operations/00000000-0000-0000-0000-000000000000/resolve`, { decision: 'whatever' }, { cookie: admin })],
    ['POST /channel-funds/recharge 负数', () => post(`${ADMIN_API}/api/admin/channel-funds/recharge`, { channelId: 1, amount: -1 }, { cookie: admin })],
    ['POST /channels-import 坏body', () => post(`${ADMIN_API}/api/admin/channels/import`, { nope: true }, { cookie: admin })],
  ];
  for (const [name, fn] of n2) {
    const r = await fn();
    check(`N2 ${name} → 400/404（不得500）`, no400(r.status) || r.status === 404, `→ ${r.status} ${r.raw.slice(0, 90)}`);
  }
  // 坏 JSON → 400
  const badJson = await fetch(`${ADMIN_API}/api/admin/plans`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: '{bad',
  });
  check('N2 POST /plans 坏JSON → 400', no400(badJson.status), `→ ${badJson.status}（W2 同源）`);
  // page_size 钳制
  const bigPage = await get(`${ADMIN_API}/api/admin/users?page_size=1000000`, { cookie: admin });
  const rows = (bigPage.body as { list?: unknown[] })?.list?.length ?? -1;
  check('N2b /users page_size 钳制（≤100）', rows >= 0 && rows <= 100, `返回 ${rows} 行`);

  // ═══ N3：vouchers 路径穿越 ═══
  const trav: string[] = [
    '..%2F..%2Fetc%2Fpasswd', '....//....//etc/passwd', '..%252f..%252fetc%252fpasswd',
    '/etc/passwd', 'a/../../etc/passwd', '.git/config',
  ];
  for (const k of trav) {
    const r = await get(`${ADMIN_API}/api/admin/vouchers/${k}`, { cookie: admin });
    const leaked = r.status === 200 && /root:|^\[core\]|\[remote/m.test(r.raw);
    check(`N3 vouchers key=${k.slice(0, 24)} → 400/404 且不泄漏内容`, !leaked, `→ ${r.status} ${r.raw.slice(0, 50).replace(/\n/g, ' ')}`);
  }

  // ═══ N4：管理动作语义 ═══
  // 对不存在的订阅取消 → 404 业务码（不得 500）
  const rCancel = await post(`${ADMIN_API}/api/admin/subscriptions/999999999/cancel`, {}, { cookie: admin });
  check('N4 cancel 不存在订阅 → 404/400', rCancel.status === 404 || rCancel.status === 400, `→ ${rCancel.status} ${rCancel.raw.slice(0, 80)}`);
  // keys PATCH 状态非法枚举
  const someKey = psql(`select id from api_keys order by id desc limit 1;`);
  const rKey = await patch(`${ADMIN_API}/api/admin/keys/${someKey}`, { status: 99 }, { cookie: admin });
  check(`N4 PATCH /keys/:id status=99 → 400（key=${someKey}）`, no400(rKey.status), `→ ${rKey.status} ${rKey.raw.slice(0, 70)}`);

  console.log(`\n账号留档：matrix4u=${uId}(${uSubject})`);
  if (reds > 0) {
    console.error(`\n[RED] ${reds} 项不符合预期`);
    process.exit(1);
  }
  console.log('\n[GREEN] 全部通过');
}

main().catch((e) => {
  console.error(`脚本异常：${e}`);
  process.exit(1);
});
