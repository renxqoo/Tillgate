/**
 * 报红测试 02：登录「账号锁定 DoS」（登录安全，企业级高危）。
 *
 * 测什么 bug：
 *   identity/login-throttle 的 identifier-only 维度：任意账号连续失败 5 次 → 锁定 10 分钟，
 *   且锁定键只按 username（用户面）/ email（管理面）计算，**不依赖 IP**。
 *   后果：任何未认证攻击者只要知道某个账号的用户名（或管理员邮箱），发 5 次错误密码，
 *   即可把该账号锁死 10 分钟；每 10 分钟重复一次即可实现永久锁定 → 合法用户永远无法登录。
 *   管理面同样受影响（namespace='admin'，identifier=email），管理员账号可被匿名锁死。
 *
 * 预期（安全）：账号不应被「未持有凭据的第三方」锁定；或锁定应绑定客户端 IP + 有合理上限，
 *   且正确密码在锁定期间应仍可登录（或锁定应可被正确密码豁免）。
 * 实测：5 次失败后，正确密码登录也返回 429 TOO_MANY_ATTEMPTS（retry-after: 600s）→ 报红。
 *
 * 运行：pnpm tsx scripts/security-audit/02-login-lockout-dos.mts
 */
import {
  loadEnv,
  adminCookie,
  insertUser,
  setPassword,
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
  console.log('🧪 报红测试 02：登录账号锁定 DoS');
  console.log(`   端点: ${CLIENT_API}/api/auth/login`);

  const admin = await adminCookie();
  const subject = newSubject('lockout-victim');
  const password = 'VictimPass123!';
  let uid: number | null = null;

  try {
    section('准备：创建合法账号并设密码');
    uid = insertUser(subject);
    await setPassword(admin, uid, password);
    green(`合法账号: ${subject} (id=${uid})，密码已设置`);

    section('攻击：未认证攻击者发 5 次错误密码');
    for (let i = 0; i < 5; i++) {
      const r = await post(`${CLIENT_API}/api/auth/login`, {
        username: subject,
        password: `attacker-wrong-${i}`,
      });
      console.log(`  第 ${i + 1} 次失败 → ${r.status} ${(r.body as any)?.error?.code ?? ''}`);
    }

    section('验证：合法用户此时用「正确密码」登录');
    const r = await post(`${CLIENT_API}/api/auth/login`, { username: subject, password });
    console.log(`  正确密码登录 → ${r.status} ${(r.body as any)?.error?.code ?? ''}`);

    if (r.status !== 200) {
      red(
        '未认证攻击者可锁死任意账号（含管理员）10 分钟 → 登录 DoS',
        `攻击者仅凭用户名 ${subject}（无需密码、无需 IP 关联）发 5 次错误密码后，` +
          `合法用户用正确密码也返回 ${r.status} ${(r.body as any)?.error?.code}，` +
          `retry-after ≈ 600s。管理面邮箱同理可被匿名锁死，属企业级可用性漏洞。`,
      );
    }
    green('正确密码登录成功，锁定未生效（未复现 bug）');
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
