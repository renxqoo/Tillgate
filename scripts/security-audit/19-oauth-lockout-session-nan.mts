/**
 * 19 · 认证面三缺陷实时验证（RED）
 *
 * R5-1 OAuth client_id 锁死 DoS：gateway /oauth/token 的尝试计数按 client_id 维度
 *   （oauth-service.ts:47-58），锁定判断在密钥校验【之前】——正确凭证也被 429 拒绝。
 *   client_id 是公开标识（用户面板可见），任何人 10 次错误 secret 即可把企业客户
 *   的令牌交换打断 10 分钟（可无限续期攻击）。对比：登录路径（auth.ts）已实现
 *   「正确密码豁免」，OAuth 路径没有同等语义。
 *
 * R5-2 改密码不注销已有会话：POST /api/auth/password 只改 users.password_hash
 *   （auth.ts:108-109），无状态会话 JWT（24h）无 jti/版本号可吊销——
 *   旧 cookie 在改密后依旧有效。会话泄露场景下受害者改密无法自救。
 *
 * R5-3 路径参数 NaN → 500：admin-api 17 处 `Number(c.req.param('id'))` 裸解析
 *   （channels.ts:163/205/226 等，packages/http/src/params.ts:5-7 注释明确禁止），
 *   非数字 id 变 NaN → PG 22P02 → 500 INTERNAL_ERROR。正确语义 400/404。
 *
 * 按指示：不清理测试数据（账号留档 ACCOUNTS-2.md）。修复后本脚本应 exit 0。
 */
import {
  loadEnv,
  psql,
  insertUser,
  setPassword,
  adminCookie,
  userLogin,
  createApp,
  post,
  patch,
  get,
  GATEWAY,
  CLIENT_API,
  ADMIN_API,
  newSubject,
} from './helpers.mts';

loadEnv();

let reds = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '[GREEN]' : '[RED]'} ${name} — ${detail}`);
  if (!ok) reds += 1;
}

async function main(): Promise<void> {
  // ── R5-1 OAuth client_id 锁死 ──
  const subject1 = newSubject('oauthlock');
  const userId1 = insertUser(subject1, '0');
  await setPassword(await adminCookie(), userId1, 'OAuthLock123!');
  const { cookie: cookie1 } = await userLogin(subject1, 'OAuthLock123!');
  const app = await createApp(cookie1, 'oauth-lock-victim');
  console.log(`[R5-1] 受害 App client_id=${app.clientId} (user ${subject1} id=${userId1})`);

  // 攻击者：10 次错误 secret
  for (let i = 0; i < 10; i++) {
    const r = await post(`${GATEWAY}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: app.clientId,
      client_secret: 'wrong-secret',
    });
    if (i === 9) console.log(`[R5-1] 第 10 次错误 secret → ${r.status}`);
  }
  // 受害者：正确 secret 换令牌
  const good = await post(`${GATEWAY}/oauth/token`, {
    grant_type: 'client_credentials',
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  check(
    'R5-1 正确凭证必须豁免 client_id 锁定',
    good.status === 200,
    `正确 secret 换令牌 → ${good.status} ${good.raw.slice(0, 160)}`,
  );

  // ── R5-2 改密码不注销旧会话 ──
  const subject2 = newSubject('sess');
  const userId2 = insertUser(subject2, '0');
  await setPassword(await adminCookie(), userId2, 'OldPass123!');
  const { cookie: oldCookie } = await userLogin(subject2, 'OldPass123!');
  const me1 = await get(`${CLIENT_API}/api/me`, { cookie: oldCookie });
  console.log(`[R5-2] 改密前 /api/me → ${me1.status}`);

  const chg = await post(
    `${CLIENT_API}/api/auth/password`,
    { oldPassword: 'OldPass123!', newPassword: 'NewPass456!' },
    { cookie: oldCookie },
  );
  console.log(`[R5-2] 修改密码 → ${chg.status}`);

  const me2 = await get(`${CLIENT_API}/api/me`, { cookie: oldCookie });
  check(
    'R5-2 改密后旧会话必须立即失效',
    me2.status === 401,
    `改密后旧 cookie /api/me → ${me2.status}（应为 401）`,
  );

  // ── R5-3 NaN 路径参数 → 500 ──
  const admin = await adminCookie();
  const nano = await patch(
    `${ADMIN_API}/api/admin/channels/abc`,
    { name: 'nan-probe' },
    { cookie: admin },
  );
  check(
    'R5-3 非数字资源 id 应返回 400/404 而非 500',
    nano.status === 400 || nano.status === 404,
    `PATCH /api/admin/channels/abc → ${nano.status} ${nano.raw.slice(0, 160)}`,
  );
  const nanoGet = await get(`${ADMIN_API}/api/admin/rate-cards/xyz`, { cookie: admin });
  check(
    'R5-3b GET 非数字 id 同样应为 400/404',
    nanoGet.status === 400 || nanoGet.status === 404,
    `GET /api/admin/rate-cards/xyz → ${nanoGet.status}`,
  );

  console.log(
    psql(
      `select id, subject from users where id in (${userId1},${userId2});`,
    ),
  );
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
