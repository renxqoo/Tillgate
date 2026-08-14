/**
 * 报红测试 04：每用户 RPM 限流在 JWT（App）鉴权路径被绕过（用户接口安全 / 限流）。
 *
 * 测什么 bug：
 *   gateway 的 AuthService.authenticateJwt 对 JWT（企业 Agent / OAuth 换的 token）路径
 *   不查 DB 里的每用户限流：`userRpmLimit: null`。而管线 buildRpmDims 里
 *   `user:{id}` 维度的上限 = `auth.userRpmLimit ?? DEFAULT_USER_RPM`，于是 JWT 请求
 *   永远退回默认 60 RPM，**管理员给该用户设的更严格 rpmLimit（例如 1）被静默无视**。
 *   攻击者/滥用用户只要自建一个 App（用户可自助创建）+ 换 JWT，即可绕过管理员对其
 *   施加的每用户 RPM 限制（1 → 60），放大流量/薅额度。
 *
 * 预期（安全）：管理员设置的每用户 rpmLimit 应对所有凭证（静态 Key 与 JWT）一致生效。
 * 实测：静态 Key 第 2 次请求返回 429（限流生效）；同用户 JWT 第 2 次请求不 429（继续放行）→ 报红。
 *
 * 说明：本测试用「余额不足以预扣」让请求在命中上游前以 402 失败，从而在不消耗真实
 * MiniMax 模型额度的情况下，通过「429 vs 非 429」判定 RPM 是否生效。
 *
 * 运行：pnpm tsx scripts/security-audit/04-jwt-rate-limit-bypass.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  createKey,
  createApp,
  post,
  patch,
  ADMIN_API,
  GATEWAY,
  newSubject,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

const MODEL = 'MiniMax-M3'; // 真实上架模型；本测试不会真正打到上游（余额不足→402）

async function chat(authHeader: string): Promise<number> {
  const res = await post(
    `${GATEWAY}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
    { headers: { authorization: authHeader } },
  );
  return res.status;
}

async function main(): Promise<void> {
  console.log('🧪 报红测试 04：JWT（App）路径绕过每用户 RPM 限流');
  console.log(`   gateway: ${GATEWAY} | 模型: ${MODEL}（余额不足会在上游前 402，无真实模型消耗）`);

  const admin = await adminCookie();
  const subject = newSubject('rpm-bypass');
  const password = 'RpmPass123!';
  let uid: number | null = null;

  try {
    section('准备：创建账号（余额 1e-6 元，无首登赠送）+ 设密码');
    uid = insertUser(subject, '0.000001');
    await setPassword(admin, uid, password);
    const { cookie } = await userLogin(subject, password);
    green(`账号 ${subject} (id=${uid}) 已就绪`);

    section('管理员把该用户 RPM 上限收紧到 1');
    const real = await patch(
      `${ADMIN_API}/api/admin/users/${uid}`,
      { rpmLimit: 1 },
      { cookie: admin },
    );
    if (real.status !== 200) throw new Error(`PATCH rpmLimit=1 失败: ${real.status} ${real.raw}`);
    green('rpmLimit=1 已生效（DB）');

    section('静态 Key 路径：第 2 次请求应被 429 限流');
    const key = await createKey(cookie);
    const a1 = await chat(`Bearer ${key}`);
    const a2 = await chat(`Bearer ${key}`);
    console.log(`  静态 Key: 第1次=${a1} 第2次=${a2}`);
    if (a2 !== 429) throw new Error(`静态 Key 第 2 次应为 429，实际 ${a2}（限流本身异常）`);

    section('JWT 路径：换 App + OAuth token，第 2 次请求本应同样 429');
    const app = await createApp(cookie);
    const tokenRes = await post(`${GATEWAY}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    if (tokenRes.status !== 200) throw new Error(`OAuth 换 token 失败: ${tokenRes.status} ${tokenRes.raw}`);
    const accessToken = (tokenRes.body as { access_token: string }).access_token;
    green('已通过 OAuth 换到 JWT access_token');

    const b1 = await chat(`Bearer ${accessToken}`);
    const b2 = await chat(`Bearer ${accessToken}`);
    console.log(`  JWT: 第1次=${b1} 第2次=${b2}`);

    if (b2 !== 429) {
      red(
        'JWT（App）鉴权绕过每用户 RPM 限流（1 → 默认 60）',
        `管理员设置 rpmLimit=1 后：静态 Key 第 2 次=429（生效），但同用户 JWT 第 2 次=${b2}（放行）。` +
          `根因：authenticateJwt 置 userRpmLimit=null，管线退回 DEFAULT_USER_RPM=60，` +
          `用户自建 App 即可放大 60 倍请求量，绕过管理员施加的限流/风控。`,
      );
    }
    green('JWT 第 2 次同样 429，每用户限流对所有凭证一致（未复现 bug）');
  } finally {
    console.log('\n（按指示：已保留本次新建账号与流水，供人工核查——未清理）');
  }
}

main().catch((err) => {
  if (!isBugConfirmed(err)) {
    console.error('\n💥 测试异常:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
});
