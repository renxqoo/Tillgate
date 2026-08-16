import { eq } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import {
  signSession,
  verifyPassword,
  hashPassword,
  recordLoginFailure,
  resetLoginFailures,
  issueLoginCodeChallenge,
  abortLoginCodeChallenge,
  verifyLoginCodeChallenge,
  LoginCodeCooldownError,
  CodeVerifyError,
  type LoginCodeVerified,
} from '@ai-gateway/identity';
import { FlowError, HttpError, recordAudit } from '@ai-gateway/http';
import { admins, isAccountUsable } from '@ai-gateway/db/schema';
import type { AdminServices } from './index.js';
import type { AdminApiConfig } from '../config.js';

/**
 * 管理员认证流程（与用户面物理隔离：admins 表 / namespace='admin' / 独立密钥）。
 *
 * 登录两分支：密码正确且未开 2FA → 直接签发会话；已开 2FA → 发邮箱验证码
 * （/login/verify 第二步）。SMTP 未配置 = fail-closed 503，绝不静默降级单密码。
 *
 * 错误处理约定（与 client-api 同模式）：失败分支在判定处直接 throw FlowError
 * （领域 kind 供审计，HTTP 语义从注册表推导），errorHandler 统一出响应；
 * 审计随判定一并落库，路由只保留成功分支的 Cookie/响应塑形。
 */

/** 审计旁路收口：管理面动作统一 actor=admin、targetType=admin */
function audit(
  s: AdminServices,
  input: { adminId: number | null; action: string; targetId: number | null; detail?: Record<string, unknown> },
): void {
  void recordAudit(s.db, {
    actor: 'admin',
    adminId: input.adminId,
    action: input.action,
    targetType: 'admin',
    targetId: input.targetId,
    detail: input.detail ?? {},
  });
}

export type AdminLoginSuccess =
  | { kind: 'session'; token: string; adminId: number; email: string }
  | { kind: 'code_required'; challengeId: string };

export async function adminLogin(
  s: AdminServices,
  config: AdminApiConfig,
  input: { email: string; password: string; ip: string },
): Promise<AdminLoginSuccess> {
  const rows = await s.db
    .select({
      id: admins.id,
      email: admins.email,
      passwordHash: admins.passwordHash,
      status: admins.status,
      twoFactorEnabled: admins.twoFactorEnabled,
    })
    .from(admins)
    .where(eq(admins.email, input.email))
    .limit(1);

  const admin = rows[0];
  // 恒定时间校验（01 修复）：邮箱不存在也跑等量 scrypt，防时序枚举。
  const passwordOk = await verifyPassword(input.password, admin?.passwordHash ?? null);

  // 正确密码豁免（02 修复）：仅密码错误才累计失败并可能触发单源锁定，
  // 正确密码永远放行并清零，防止管理员邮箱被匿名锁死。
  if (!admin || !passwordOk) {
    const throttle = await recordLoginFailure(s.redis, 'admin', input.email, input.ip);
    if (throttle.locked) {
      audit(s, {
        adminId: null,
        action: 'auth.login.locked',
        targetId: admin?.id ?? null,
        detail: { email: input.email, ip: input.ip },
      });
      throw new FlowError('locked', {
        code: 'TOO_MANY_ATTEMPTS',
        message: '登录尝试过多，已临时锁定',
        headers: { 'retry-after': String(throttle.retryAfterSec) },
      });
    }
    audit(s, {
      adminId: null,
      action: 'auth.login.invalid_credentials',
      targetId: admin?.id ?? null,
      detail: { email: input.email, ip: input.ip },
    });
    throw new FlowError('invalid_credentials', { code: 'INVALID_CREDENTIALS' });
  }

  // 不区分封禁/注销：登录口统一「账号不可用」（与用户面同语义，防状态泄露）
  if (!isAccountUsable(admin.status)) {
    throw new FlowError('account_unavailable', { code: 'ACCOUNT_UNAVAILABLE' });
  }

  await resetLoginFailures(s.redis, 'admin', input.email, input.ip);
  await s.db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));

  // ── 邮箱验证码二次登录（第八轮）：开启 2FA 的管理员密码正确后先发码，
  //    验证通过（/login/verify）才签发会话。
  if (admin.twoFactorEnabled) {
    if (!s.mailer) {
      audit(s, {
        adminId: admin.id,
        action: 'auth.login.2fa_unavailable',
        targetId: admin.id,
        detail: { email: input.email, ip: input.ip },
      });
      throw new FlowError('mailer_unavailable', {
        code: 'TWO_FACTOR_UNAVAILABLE',
        message: '已开启邮箱验证码登录，但服务端未配置 SMTP——请联系运维（不降级为单密码）',
      });
    }
    // 限发：每管理员 60s 一条（防邮件轰炸）；挑战签发/验证统一走 identity login-code
    const code = String(randomInt(100000, 1000000));
    let challengeId: string;
    try {
      challengeId = await issueLoginCodeChallenge(s.redis, 'admin', String(admin.id), code);
    } catch (e) {
      if (e instanceof LoginCodeCooldownError) {
        throw new FlowError('code_rate_limited', {
          code: 'CODE_RATE_LIMITED',
          message: '验证码发送过于频繁，请 1 分钟后再试',
        });
      }
      throw e;
    }
    try {
      await s.mailer.sendLoginCode(admin.email, code, { ip: input.ip });
    } catch (e) {
      await abortLoginCodeChallenge(s.redis, 'admin', String(admin.id), challengeId);
      audit(s, {
        adminId: admin.id,
        action: 'auth.login.2fa_send_failed',
        targetId: admin.id,
        detail: { email: input.email, err: (e as Error).message.slice(0, 120) },
      });
      throw new FlowError('code_send_failed', {
        code: 'CODE_SEND_FAILED',
        message: '验证码邮件发送失败，请稍后重试或联系运维',
      });
    }
    audit(s, {
      adminId: admin.id,
      action: 'auth.login.2fa_challenge',
      targetId: admin.id,
      detail: { email: input.email, ip: input.ip },
    });
    return { kind: 'code_required', challengeId };
  }

  audit(s, {
    adminId: admin.id,
    action: 'auth.login.success',
    targetId: admin.id,
    detail: { email: input.email, ip: input.ip },
  });

  const token = await signSession({ type: 'admin', id: admin.id }, config.adminJwtSecret);
  return { kind: 'session', token, adminId: admin.id, email: admin.email };
}

/** 2FA 第二步：验码（挑战 5 分钟有效，错 5 次作废）→ 状态复查 → 签发会话 */
export async function verifyAdminLoginCode(
  s: AdminServices,
  config: AdminApiConfig,
  input: { challengeId: string; code: string; ip: string },
): Promise<{ token: string; adminId: number; email: string }> {
  let verified: LoginCodeVerified;
  try {
    verified = await verifyLoginCodeChallenge(s.redis, 'admin', input.challengeId, input.code);
  } catch (e) {
    if (e instanceof CodeVerifyError) {
      if (e.reason === 'CODE_INVALID') {
        throw new FlowError('code_invalid', { code: 'CODE_INVALID', message: '验证码错误' });
      }
      throw new FlowError('challenge_invalid', {
        code: 'CHALLENGE_INVALID',
        message: '验证码已过期、不存在或错误次数过多，请重新登录',
      });
    }
    throw e;
  }
  const adminId = Number(verified.subjectId);
  const admin = await s.db.query.admins.findFirst({
    where: eq(admins.id, adminId),
    columns: { id: true, email: true, status: true, sessionInvalidBefore: true },
  });
  if (!admin || !isAccountUsable(admin.status)) {
    throw new FlowError('account_unavailable', { code: 'ACCOUNT_UNAVAILABLE', message: '账号不可用' });
  }
  audit(s, {
    adminId: admin.id,
    action: 'auth.login.success',
    targetId: admin.id,
    detail: { email: admin.email, ip: input.ip, twoFactor: true },
  });
  const token = await signSession({ type: 'admin', id: admin.id }, config.adminJwtSecret);
  return { token, adminId: admin.id, email: admin.email };
}

/** 邮箱验证码二次登录开关（自助；开启要求 SMTP 已配置——fail-closed） */
export async function setTwoFactorEnabled(
  s: AdminServices,
  adminId: number,
  enabled: boolean,
): Promise<boolean> {
  if (enabled && !s.mailer) {
    throw new HttpError('SMTP_NOT_CONFIGURED', '服务端未配置 SMTP，无法开启邮箱验证码登录');
  }
  const [updated] = await s.db
    .update(admins)
    .set({ twoFactorEnabled: enabled, updatedAt: new Date() })
    .where(eq(admins.id, adminId))
    .returning({ id: admins.id, twoFactorEnabled: admins.twoFactorEnabled });
  if (!updated) throw new HttpError('ADMIN_NOT_FOUND', '管理员不存在');
  audit(s, { adminId, action: 'auth.two_factor.toggle', targetId: adminId, detail: { enabled } });
  return updated.twoFactorEnabled;
}

/** 改密码：校验原密码 → 换哈希 + 会话失效线（R5-2：改密即吊销全部管理会话） */
export async function changeAdminPassword(
  s: AdminServices,
  adminId: number,
  input: { oldPassword: string; newPassword: string },
): Promise<void> {
  const rows = await s.db
    .select({ id: admins.id, passwordHash: admins.passwordHash })
    .from(admins)
    .where(eq(admins.id, adminId))
    .limit(1);
  if (rows.length === 0) throw new HttpError('ADMIN_NOT_FOUND', '管理员不存在');

  const ok = await verifyPassword(input.oldPassword, rows[0]!.passwordHash);
  if (!ok) throw new HttpError('INVALID_CREDENTIALS', '原密码错误');

  const newHash = await hashPassword(input.newPassword);
  await s.db
    .update(admins)
    .set({ passwordHash: newHash, sessionInvalidBefore: new Date(), updatedAt: new Date() })
    .where(eq(admins.id, rows[0]!.id));
  audit(s, { adminId, action: 'admin.password_change', targetId: adminId });
}

/** 当前管理员信息（前端守卫用） */
export async function getAdminMe(s: AdminServices, adminId: number) {
  const rows = await s.db
    .select({ id: admins.id, email: admins.email, displayName: admins.displayName, lastLoginAt: admins.lastLoginAt, twoFactorEnabled: admins.twoFactorEnabled })
    .from(admins)
    .where(eq(admins.id, adminId))
    .limit(1);
  if (rows.length === 0) throw new HttpError('ADMIN_NOT_FOUND', '管理员不存在');
  return rows[0];
}
