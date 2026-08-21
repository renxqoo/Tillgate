/**
 * 报红测试 03：CSRF —— 会话 API 缺少 Origin/Referer 校验（用户接口安全）。
 *
 * 测什么 bug：
 *   client-api 的会话是 HttpOnly + SameSite=Lax Cookie（ag_session），所有状态变更接口
 *   （POST /api/keys 建 Key、POST /api/apps 建 App、POST /api/redeem 兑换、PATCH/DELETE keys、
 *    POST /api/auth/password 改密码…）只依赖 Cookie，**没有任何 CSRF Token 或 Origin 校验**。
 *   SameSite=Lax 能挡「跨站 POST」这一种形态，但挡不住：同站子域被 XSS/接管、SameSite=Lax
 *   在部分浏览器对某些场景的绕过、以及「浏览器不拦截但服务端本应二次校验」的纵深防御缺失。
 *   本测试证明：服务端对带恶意 Origin 的跨源请求照单全收（照常执行业务），缺少服务端 CSRF 防线。
 *
 * 预期（安全）：带跨源 Origin 的状态变更请求应被服务端拒绝（403）。
 * 实测：POST /api/keys 带 Origin: https://evil.example 仍返回 201 并真实创建 Key → 报红。
 *
 * 运行：pnpm tsx scripts/security-audit/03-csrf-missing-origin-check.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
  userLogin,
  post,
  CLIENT_API,
  newSubject,
  red,
  isBugConfirmed,
  green,
  section,
} from './helpers.mts';

loadEnv();

async function main(): Promise<void> {
  console.log('🧪 报红测试 03：CSRF —— 状态变更接口缺少 Origin 校验');
  console.log(`   端点: ${CLIENT_API}/api/keys`);

  const admin = await adminCookie();
  const subject = newSubject('csrf-victim');
  const password = 'CsrfPass123!';
  let uid: number | null = null;

  try {
    section('准备：创建合法账号并登录拿会话 cookie');
    uid = insertUser(subject);
    await setPassword(admin, uid, password);
    const { cookie } = await userLogin(subject, password);
    green(`已登录: ${subject} (id=${uid})，持有 ag_session`);

    section('攻击：跨源（Origin: https://evil.example）发状态变更请求');
    const r = await post(
      `${CLIENT_API}/api/keys`,
      { name: 'csrf-injected-key' },
      { cookie, headers: { origin: 'https://evil.example' } },
    );
    console.log(`  POST /api/keys (Origin=evil) → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

    // 同时验证改密码这类高敏接口同样无 Origin 校验（密码错误只会 401，说明请求被处理而非被 CSRF 拦截）
    const pw = await post(
      `${CLIENT_API}/api/auth/password`,
      { oldPassword: 'wrong-old-pw', newPassword: 'NewPass123!' },
      { cookie, headers: { origin: 'https://evil.example' } },
    );
    console.log(`  POST /api/auth/password (Origin=evil) → ${pw.status} ${JSON.stringify(pw.body).slice(0, 120)}`);

    if (r.status === 201) {
      red(
        '会话状态变更接口无 Origin/Referer 服务端校验 → CSRF 风险',
        `POST /api/keys 携带跨源 Origin=https://evil.example 仍被接受并真实创建 Key（201）。` +
          `服务端仅依赖 SameSite=Lax Cookie，缺少 CSRF Token / Origin 校验作为纵深防御；` +
          `一旦攻击者在同站子域获得 XSS 或浏览器 SameSite 被绕过，即可以受害者身份建 Key/改密码/兑换充值码。`,
      );
    }
    green('跨源请求被服务端拒绝（未复现 bug）');
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
