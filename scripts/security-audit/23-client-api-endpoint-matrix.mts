/**
 * 23 · 第四轮逐接口审计①：client-api（用户面 :8791）接口矩阵
 *
 * 对 ENDPOINTS.md 中 client-api 全部 25 个接口逐一实弹：
 *   M1 无 cookie → 必须 401（鉴权覆盖）
 *   M2 管理员 cookie（错面）→ 必须 401（双平面隔离）
 *   M3 横向越权：B 用户操作 A 用户资源（key/app/订阅/org/成员）→ 必须 404/403，
 *      且不得产生副作用（A 资源必须原样存在）
 *   M4 非法输入：NaN/负数/超长/空串/坏 JSON → 必须 400，不得 500
 *
 * 数据纪律：账号前缀 matrix4a-/matrix4b-，全部保留不清理（留档 ACCOUNTS-4）。
 * 全部通过 exit 0；任何一项不符合预期即 RED exit 1。
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
  patch,
  get,
  newSubject,
  CLIENT_API,
} from './helpers.mts';

loadEnv();

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}
async function del(url: string, cookie?: string): Promise<{ status: number; raw: string }> {
  const res = await fetch(url, { method: 'DELETE', headers: cookie ? { cookie } : {} });
  return { status: res.status, raw: await res.text() };
}
const no401 = (s: number) => s === 401;
const no400 = (s: number) => s === 400;

async function main(): Promise<void> {
  // ── 准备：A（企业，买席位套餐建 org）+ B（普通）──
  const aSubject = newSubject('matrix4a');
  const bSubject = newSubject('matrix4b');
  const aId = insertUser(aSubject, '1000');
  const bId = insertUser(bSubject, '10');
  const admin = await adminCookie();
  await setPassword(admin, aId, 'MatrixA123!');
  await setPassword(admin, bId, 'MatrixB123!');
  const a = (await userLogin(aSubject, 'MatrixA123!')).cookie;
  const b = (await userLogin(bSubject, 'MatrixB123!')).cookie;

  // A 建 key/app
  const keyRes = await post(`${CLIENT_API}/api/keys`, { name: 'matrix4a-key' }, { cookie: a });
  const aKeyId = (keyRes.body as { id?: number }).id;
  const appRes = await post(`${CLIENT_API}/api/apps`, { name: 'matrix4a-app' }, { cookie: a });
  const aAppId = (appRes.body as { id?: number }).id;

  // A 买席位套餐建 org（ensureOrg）
  psql(`update users set is_enterprise=true where id=${aId};`);
  const seatsPlan = psql(
    `select id from plans where status=0 and kind='subscription' and allow_seats and price>0 and price<=1000 order by price asc limit 1;`,
  );
  let aOrgId = 0;
  let aSubId = 0;
  if (seatsPlan) {
    const buy = await post(
      `${CLIENT_API}/api/subscriptions`,
      { planId: Number(seatsPlan), quantity: 2 },
      { cookie: a, headers: { 'idempotency-key': `matrix4-${aId}` } },
    );
    aSubId = Number(
      psql(`select id from user_subscriptions where user_id=${aId} order by id desc limit 1;`),
    );
    aOrgId = Number(
      psql(`select id from organizations where owner_user_id=${aId} order by id desc limit 1;`),
    );
    console.log(`[setup] A=${aId} B=${bId} key=${aKeyId} app=${aAppId} sub=${aSubId} org=${aOrgId} 购买=${buy.status}`);
  } else {
    console.log('[setup] 无上架席位套餐，org 相关项将跳过');
  }

  // ═══ M1：无 cookie 全接口 401 ═══
  const gets = [
    '/api/auth/session', '/api/me', '/api/me/subscription', '/api/me/transactions',
    '/api/keys', '/api/apps', '/api/usage', '/api/usage/by-model', '/api/usage/summary',
    '/api/usage/rate', '/api/redeem/history', '/api/plans', '/api/orgs',
  ];
  for (const p of gets) {
    const r = await get(`${CLIENT_API}${p}`);
    check(`M1 GET ${p} 无cookie=401`, no401(r.status), `→ ${r.status}`);
  }
  const posts: [string, unknown][] = [
    // logout 不在此列：公开组幂等清 cookie（200 为设计行为，下方单独验证）
    ['/api/auth/password', { oldPassword: 'x', newPassword: 'y' }],
    ['/api/keys', { name: 'x' }],
    ['/api/apps', { name: 'x' }],
    ['/api/redeem', { code: 'x' }],
    ['/api/subscriptions', { planId: 1 }],
    ['/api/orgs/invitations/accept', { token: 'x' }],
  ];
  for (const [p, body] of posts) {
    const r = await post(`${CLIENT_API}${p}`, body);
    check(`M1 POST ${p} 无cookie=401`, no401(r.status), `→ ${r.status}`);
  }
  const rDel = await del(`${CLIENT_API}/api/keys/999999`);
  check('M1 DELETE /api/keys/:id 无cookie=401', no401(rDel.status), `→ ${rDel.status}`);
  const rPatch = await patch(`${CLIENT_API}/api/keys/999999`, { name: 'x' });
  check('M1 PATCH /api/keys/:id 无cookie=401', no401(rPatch.status), `→ ${rPatch.status}`);

  // logout 无 cookie：幂等清 cookie，200 且无副作用（设计行为）
  const rLo = await post(`${CLIENT_API}/api/auth/logout`, {});
  check('M1b POST /api/auth/logout 无cookie=200（幂等设计）', rLo.status === 200, `→ ${rLo.status}`);

  // ═══ M2：管理员 cookie（错面）→ 401 ═══
  const adminLogin = await post('http://127.0.0.1:8790/api/admin/auth/login', {
    email: 'admin@ai-gateway.local', password: 'admin12345',
  });
  const adminCookieStr = (adminLogin.headers.getSetCookie?.() ?? [])
    .find((c: string) => c.startsWith('admin_session'))?.split(';')[0] ?? '';
  for (const p of ['/api/me', '/api/keys', '/api/orgs', '/api/subscriptions']) {
    const r = await get(`${CLIENT_API}${p}`, { cookie: adminCookieStr });
    check(`M2 GET ${p} 管理员cookie=401（双平面隔离）`, no401(r.status), `→ ${r.status} ${r.raw.slice(0, 80)}`);
  }
  const rA = await post(`${CLIENT_API}/api/keys`, { name: 'x' }, { cookie: adminCookieStr });
  check('M2 POST /api/keys 管理员cookie=401', no401(rA.status), `→ ${rA.status}`);

  // ═══ M3：横向越权（B 打 A 的资源）═══
  const m3: [string, () => Promise<{ status: number; raw: string }>][] = [
    ['GET /api/orgs/:id(A) 非成员', () => get(`${CLIENT_API}/api/orgs/${aOrgId}`, { cookie: b })],
    ['PATCH /api/keys/:id(A)', () => patch(`${CLIENT_API}/api/keys/${aKeyId}`, { name: 'hacked' }, { cookie: b })],
    ['POST /api/keys/:id/rotate(A)', () => post(`${CLIENT_API}/api/keys/${aKeyId}/rotate`, {}, { cookie: b })],
    ['DELETE /api/keys/:id(A)', () => del(`${CLIENT_API}/api/keys/${aKeyId}`, b)],
    ['POST /api/apps/:id/rotate-secret(A)', () => post(`${CLIENT_API}/api/apps/${aAppId}/rotate-secret`, {}, { cookie: b })],
    ['DELETE /api/apps/:id(A)', () => del(`${CLIENT_API}/api/apps/${aAppId}`, b)],
    ['POST /api/subscriptions/:id(A)/change', () => post(`${CLIENT_API}/api/subscriptions/${aSubId}/change`, { targetPlanId: 1, quantity: 1 }, { cookie: b })],
    ['POST /api/subscriptions/:id(A)/renew', () => post(`${CLIENT_API}/api/subscriptions/${aSubId}/renew`, {}, { cookie: b })],
  ];
  if (aOrgId > 0) {
    m3.push(
      ['PATCH /api/orgs/:id(A)/members/:userId(A)', () => patch(`${CLIENT_API}/api/orgs/${aOrgId}/members/${aId}`, { dailySpendLimit: 1 }, { cookie: b })],
      ['DELETE /api/orgs/:id(A)/members/:userId(A)', () => del(`${CLIENT_API}/api/orgs/${aOrgId}/members/${aId}`, b)],
    );
  }
  for (const [name, fn] of m3) {
    const r = await fn();
    check(`M3 ${name} → 404/403`, r.status === 404 || r.status === 403, `→ ${r.status} ${r.raw.slice(0, 80)}`);
  }
  // 副作用核验：A 的 key/app 必须原样存在
  const keyAlive = psql(`select count(*) from api_keys where id=${aKeyId} and status=0;`);
  check('M3b B 的越权操作不得产生副作用（A key 仍在）', keyAlive === '1', `api_keys=${keyAlive}`);

  // B 用 A 的订阅 id 建 Key / App（订阅归属校验）
  const bKeyWithASub = await post(
    `${CLIENT_API}/api/keys`, { name: 'matrix4b-key', subscriptionId: aSubId }, { cookie: b },
  );
  check(
    'M3c B 用 A 的 subscriptionId 建 Key → 4xx',
    [400, 403, 404].includes(bKeyWithASub.status),
    `→ ${bKeyWithASub.status} ${bKeyWithASub.raw.slice(0, 90)}`,
  );
  const bAppWithASub = await post(
    `${CLIENT_API}/api/apps`, { name: 'matrix4b-app', subscriptionId: aSubId }, { cookie: b },
  );
  check(
    'M3d B 用 A 的 subscriptionId 建 App → 4xx（apps.ts 是否有归属校验？）',
    [400, 403, 404].includes(bAppWithASub.status),
    `→ ${bAppWithASub.status} ${bAppWithASub.raw.slice(0, 90)}`,
  );

  // ═══ M4：非法输入 400 不 500 ═══
  const m4: [string, () => Promise<{ status: number; raw: string }>][] = [
    ['POST /api/keys name=""', () => post(`${CLIENT_API}/api/keys`, { name: '' }, { cookie: a })],
    ['POST /api/keys name 65字', () => post(`${CLIENT_API}/api/keys`, { name: 'K'.repeat(65) }, { cookie: a })],
    ['POST /api/keys dailySpendLimit=-1', () => post(`${CLIENT_API}/api/keys`, { name: 'x', dailySpendLimit: -1 }, { cookie: a })],
    ['POST /api/keys subscriptionId=0', () => post(`${CLIENT_API}/api/keys`, { name: 'x', subscriptionId: 0 }, { cookie: a })],
    ['POST /api/subscriptions planId=-1', () => post(`${CLIENT_API}/api/subscriptions`, { planId: -1 }, { cookie: a })],
    ['POST /api/subscriptions quantity=0', () => post(`${CLIENT_API}/api/subscriptions`, { planId: 1, quantity: 0 }, { cookie: a })],
    ['POST /api/redeem code=""', () => post(`${CLIENT_API}/api/redeem`, { code: '' }, { cookie: a })],
    ['POST /api/orgs/invitations/accept token=""', () => post(`${CLIENT_API}/api/orgs/invitations/accept`, { token: '' }, { cookie: a })],
    ['PATCH /api/keys/abc（NaN id）', () => patch(`${CLIENT_API}/api/keys/abc`, { name: 'x' }, { cookie: a })],
    ['POST /api/apps/abc/rotate-secret（NaN id）', () => post(`${CLIENT_API}/api/apps/abc/rotate-secret`, {}, { cookie: a })],
    ['GET /api/orgs/abc（NaN id）', () => get(`${CLIENT_API}/api/orgs/abc`, { cookie: a })],
    ['GET /api/usage/summary?from=notadate', () => get(`${CLIENT_API}/api/usage/summary?from=notadate`, { cookie: a })],
  ];
  for (const [name, fn] of m4) {
    const r = await fn();
    check(`M4 ${name} → 400（不得500）`, no400(r.status), `→ ${r.status} ${r.raw.slice(0, 80)}`);
  }
  // 坏 JSON → 400
  const badJson = await fetch(`${CLIENT_API}/api/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: a }, body: '{bad json',
  });
  check('M4 POST /api/keys 坏JSON → 400', no400(badJson.status), `→ ${badJson.status}`);

  // 分页上限：page_size 巨大也只返回 ≤100 行（api-contract §4）
  const bigPage = await get(`${CLIENT_API}/api/me/transactions?page=1&page_size=1000000`, { cookie: a });
  const rows = (bigPage.body as { list?: unknown[] })?.list?.length ?? -1;
  check('M4b page_size 被钳制（≤100）', rows >= 0 && rows <= 100, `返回 ${rows} 行 status=${bigPage.status}`);

  console.log(`\n账号留档：A=${aId}(${aSubject}) B=${bId}(${bSubject}) key=${aKeyId} app=${aAppId} sub=${aSubId} org=${aOrgId}`);
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
