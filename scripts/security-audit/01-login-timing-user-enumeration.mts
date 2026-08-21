/**
 * 报红测试 01：登录「用户名枚举」时序侧信道（登录安全）。
 *
 * 测什么 bug：
 *   client-api /api/auth/login（以及 admin-api /api/admin/auth/login）声称对「用户不存在」
 *   与「密码错误」返回完全一致、且做恒定时间校验（见 services/auth.ts 注释）。
 *   但实际代码：`const passwordOk = user ? await verifyPassword(...) : false;`
 *   —— 用户不存在时根本不跑 scrypt（verifyPassword 对空 hash 也直接短路 return false）。
 *   于是：存在的账号（有密码哈希）登录会执行 ~50ms 的 scrypt，不存在的账号 ~2ms 直接返回。
 *   攻击者用响应时长即可枚举哪些用户名/邮箱是已开通的真实账号（存在→慢，不存在→快）。
 *
 * 预期（安全）：存在与不存在的登录响应时长中位数之差应 < 15ms（无法可靠区分）。
 * 实测：~43ms vs ~2.5ms，差约 40ms → 报红。
 *
 * 运行：pnpm tsx scripts/security-audit/01-login-timing-user-enumeration.mts
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

const SAMPLES = 5;
const THRESHOLD_MS = 15; // 安全阈值：中位差超过它即可被可靠区分

async function timeLogin(username: string, password: string): Promise<number> {
  const t0 = process.hrtime.bigint();
  const res = await post(`${CLIENT_API}/api/auth/login`, { username, password });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.status !== 401) throw new Error(`预期 401，实际 ${res.status}: ${res.raw}`);
  return ms;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function main(): Promise<void> {
  console.log('🧪 报红测试 01：登录用户名枚举（时序侧信道）');
  console.log(`   端点: ${CLIENT_API}/api/auth/login | 样本数: ${SAMPLES} | 安全阈值: ${THRESHOLD_MS}ms`);

  const admin = await adminCookie();
  const created: number[] = [];
  const existingSubjects: string[] = [];

  try {
    // 造 5 个「已开通」账号（有密码）—— 每个只打 1 次错误密码，避免触发锁定
    section('准备：创建 5 个已开通账号（有密码哈希）');
    for (let i = 0; i < SAMPLES; i++) {
      const subject = newSubject('timing-exist');
      const uid = insertUser(subject);
      created.push(uid);
      existingSubjects.push(subject);
      await setPassword(admin, uid, 'TimingPass123!');
      green(`已创建并设密码: ${subject} (id=${uid})`);
    }

    section('攻击：测量「账号存在(密码错)」vs「账号不存在」的登录响应时长');
    const existMs: number[] = [];
    const nonexistMs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      existMs.push(await timeLogin(existingSubjects[i]!, 'wrong-password'));
      nonexistMs.push(await timeLogin(newSubject('timing-none'), 'whatever'));
    }

    const existMed = median(existMs);
    const nonexistMed = median(nonexistMs);
    const diff = existMed - nonexistMed;

    console.log(`  存在账号中位耗时: ${existMed.toFixed(1)}ms`);
    console.log(`  不存在账号中位耗时: ${nonexistMed.toFixed(1)}ms`);
    console.log(`  中位差: ${diff.toFixed(1)}ms (安全阈值 < ${THRESHOLD_MS}ms)`);

    if (diff >= THRESHOLD_MS) {
      red(
        '登录时序侧信道 → 用户名/邮箱可枚举',
        `存在账号比不存在账号慢 ${diff.toFixed(1)}ms（scrypt 只在账号存在时执行）。` +
          `攻击者可据此枚举已开通账号，再配合 02 的锁定 DoS 精准打击任意账号。`,
      );
    }
    green(`中位差 ${diff.toFixed(1)}ms < ${THRESHOLD_MS}ms，时序不可区分（未复现 bug）`);
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
