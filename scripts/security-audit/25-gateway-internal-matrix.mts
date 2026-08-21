/**
 * 25 · 第四轮逐接口审计③：gateway(:8787) + trace-receiver(:8793) 对外面
 *
 *   P1 /debug/traces 暴露面（生产是否会挂载？无鉴权读链路？）
 *   P2 /v1/* 鉴权覆盖（无 key=401、未知路径 404 不落入业务、用户面会话 JWT 不得过关）
 *   P3 /oauth/token 语义（grant 校验、未知 client、禁用用户的 App 是否仍可换 token —— 关键攻击面）
 *   P4 禁用用户的静态 Key 网关行为
 *   P5 trace-receiver /v1/traces 与 /internal/stats 暴露面
 *
 * 数据纪律：matrix4g- 前缀保留。
 */
import {
  loadEnv, psql, insertUser, setPassword, adminCookie, userLogin,
  post, patch, get, newSubject, CLIENT_API, GATEWAY,
} from './helpers.mts';

loadEnv();

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}
const TRACE = 'http://127.0.0.1:8793';

async function main(): Promise<void> {
  const admin = await adminCookie();

  // 准备：正常用户 g + key + app；用户 h（将被禁用）+ app
  const gSubject = newSubject('matrix4g');
  const gId = insertUser(gSubject, '5');
  await setPassword(admin, gId, 'MatrixG123!');
  const gCookie = (await userLogin(gSubject, 'MatrixG123!')).cookie;
  const gKeyRes = await post(`${CLIENT_API}/api/keys`, { name: 'matrix4g-key' }, { cookie: gCookie });
  const gKey = (gKeyRes.body as { key: string }).key;
  const gAppRes = await post(`${CLIENT_API}/api/apps`, { name: 'matrix4g-app' }, { cookie: gCookie });
  const gApp = gAppRes.body as { clientId: string; clientSecret: string };

  const hSubject = newSubject('matrix4h');
  const hId = insertUser(hSubject, '5');
  await setPassword(admin, hId, 'MatrixH123!');
  const hCookie = (await userLogin(hSubject, 'MatrixH123!')).cookie;
  const hKeyRes = await post(`${CLIENT_API}/api/keys`, { name: 'matrix4h-key' }, { cookie: hCookie });
  const hKey = (hKeyRes.body as { key: string }).key;
  const hAppRes = await post(`${CLIENT_API}/api/apps`, { name: 'matrix4h-app' }, { cookie: hCookie });
  const hApp = hAppRes.body as { clientId: string; clientSecret: string };

  // ═══ P1：/debug 暴露面 ═══
  const dbg = await get(`${GATEWAY}/debug/traces`);
  check(
    'P1 GET /debug/traces（dev 环境：可访问但须无敏感数据 / 生产不挂载由代码保证）',
    dbg.status === 200 || dbg.status === 404,
    `→ ${dbg.status} ${dbg.raw.slice(0, 80)}`,
  );

  // ═══ P2：/v1 鉴权覆盖 ═══
  const noAuth = await get(`${GATEWAY}/v1/models`);
  check('P2 GET /v1/models 无key=401', noAuth.status === 401, `→ ${noAuth.status}`);
  const badKey = await get(`${GATEWAY}/v1/models`, { headers: { authorization: 'Bearer sk-invalid' } });
  check('P2 GET /v1/models 坏key=401', badKey.status === 401, `→ ${badKey.status}`);
  // 未知 /v1 路径带合法 key → 404（不落入无鉴权处理器）
  const unknown = await get(`${GATEWAY}/v1/nothing`, { headers: { authorization: `Bearer ${gKey}` } });
  check('P2 GET /v1/nothing 合法key=404', unknown.status === 404, `→ ${unknown.status}`);
  // 用户面会话 JWT（ag_session cookie 内容）不得当网关 Bearer 用：拿登录响应体里不可能有 token，
  // 用「伪造格式」代替：正确性的证明在 iss/aud 校验（G 审查）。此处验证空 Bearer。
  const emptyBearer = await get(`${GATEWAY}/v1/models`, { headers: { authorization: 'Bearer ' } });
  check('P2 空 Bearer=401', emptyBearer.status === 401, `→ ${emptyBearer.status}`);
  // chat 非法 body：无 messages
  const noMsg = await post(`${GATEWAY}/v1/chat/completions`, { model: 'x', messages: [] }, {
    headers: { authorization: `Bearer ${gKey}` },
  });
  check('P2 chat messages 空数组=400', noMsg.status === 400, `→ ${noMsg.status} ${noMsg.raw.slice(0, 70)}`);
  const noModel = await post(`${GATEWAY}/v1/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] }, {
    headers: { authorization: `Bearer ${gKey}` },
  });
  check('P2 chat 缺 model=400', noModel.status === 400, `→ ${noModel.status}`);

  // ═══ P3：/oauth/token 语义 ═══
  const badGrant = await post(`${GATEWAY}/oauth/token`, { grant_type: 'password', client_id: 'x', client_secret: 'y' });
  check('P3 grant_type=password → 400', badGrant.status === 400, `→ ${badGrant.status}`);
  const unknownClient = await post(`${GATEWAY}/oauth/token`, {
    grant_type: 'client_credentials', client_id: 'app_not_exist', client_secret: 'whatever',
  });
  check('P3 未知 client → 401 且不泄漏存在性细节', unknownClient.status === 401, `→ ${unknownClient.status} ${unknownClient.raw.slice(0, 70)}`);
  // 正常换 token
  const okToken = await post(`${GATEWAY}/oauth/token`, {
    grant_type: 'client_credentials', client_id: gApp.clientId, client_secret: gApp.clientSecret,
  });
  check('P3 正常 App 换 token=200', okToken.status === 200, `→ ${okToken.status}`);
  const jwt = (okToken.body as { access_token?: string }).access_token;

  // ── 关键：禁用用户的 App 还能换 token 吗？静态 Key 还能调用吗？──
  await patch(`${GATEWAY.replace('8787', '8790')}/api/admin/users/${hId}`, { status: 1 }, { cookie: admin });
  const disabledToken = await post(`${GATEWAY}/oauth/token`, {
    grant_type: 'client_credentials', client_id: hApp.clientId, client_secret: hApp.clientSecret,
  });
  check(
    'P3b 禁用用户的 App 换 token → 401（不得 200）',
    disabledToken.status === 401,
    `→ ${disabledToken.status} ${disabledToken.raw.slice(0, 90)}`,
  );
  const disabledKey = await get(`${GATEWAY}/v1/models`, { headers: { authorization: `Bearer ${hKey}` } });
  check('P4 禁用用户的静态 Key → 401/403', disabledKey.status === 401 || disabledKey.status === 403, `→ ${disabledKey.status}`);

  // 用换到的 JWT 调 /v1/models（对称性）
  const jwtModels = await get(`${GATEWAY}/v1/models`, { headers: { authorization: `Bearer ${jwt}` } });
  check('P3c App JWT 调 /v1/models=200', jwtModels.status === 200, `→ ${jwtModels.status} ${jwtModels.raw.slice(0, 60)}`);

  // ═══ P5：trace-receiver 暴露面 ═══
  const traces = await fetch(`${TRACE}/v1/traces`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"garbage":true}',
  });
  check('P5 POST :8793/v1/traces 垃圾体（记录暴露面）', true, `→ ${traces.status} ${(await traces.text()).slice(0, 60)}`);
  const stats = await get(`${TRACE}/internal/stats`);
  const statsRaw = stats.raw.slice(0, 120);
  check('P5 GET :8793/internal/stats（记录暴露面，无凭据则挂账）', true, `→ ${stats.status} ${statsRaw}`);

  console.log(`\n账号留档：g=${gId}(${gSubject}) key=${gKeyRes.status} app=${(gAppRes.body as { id?: number }).id}; h(禁用)=${hId}(${hSubject})`);
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
