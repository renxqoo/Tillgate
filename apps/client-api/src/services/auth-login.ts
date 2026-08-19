import { and, eq } from 'drizzle-orm';
import {
  hashPassword,
  recordLoginFailure,
  resetLoginFailures,
  verifyPassword,
  advanceAnchor,
  createLoginCodeChallenger,
  DeliveryFailedError,
  LoginCodeCooldownError,
  CodeVerifyError,
  type LoginCodeVerified,
} from '@ai-gateway/identity';
import { users, isAccountUsable } from '@ai-gateway/db/schema';
import { FlowError, recordAudit } from '@ai-gateway/http';
import type { ClientServices } from './index.js';
import type { ClientApiConfig } from '../config.js';
import { audited, issueSession, type VerifySuccess } from './auth-common.js';

/**
 * 邮箱登录流程（强制邮箱验证码，两步）：
 *
 * 第一步 login()：查本地账号（email）→ 恒定时间密码校验（防枚举/防时序）
 *   → 密码错误才累计失败（正确密码豁免，防锁定 DoS）→ 状态检查 → 清零失败计数
 *   → 发 6 位验证码（60s 冷却/账号，5 分钟有效）→ 返回 challenge（不签会话）。
 *
 * 第二步 verifyLoginCode()：验码（错 5 次作废，一次性消费防重放）→ 状态复查
 *   → 首登赠额（幂等，由 ledger 判定）→ 更新 last_login → 签发会话 JWT。
 *
 * 失败分支在判定处直接 throw FlowError（领域 kind 供审计，HTTP 语义从注册表
 * 推导），errorHandler 统一出响应；审计由 audited() 收口随成败一并落库。
 */

export interface LoginInput {
  email: string;
  password: string;
  ip: string;
}

export type LoginSuccess = { kind: 'code_required'; challengeId: string };

export async function login(
  s: ClientServices,
  config: ClientApiConfig,
  input: LoginInput,
): Promise<LoginSuccess> {
  return audited(
    s,
    { action: 'auth.login', detail: () => ({ email: input.email.slice(0, 64), ip: input.ip }) },
    async () => {
      const email = input.email.trim().toLowerCase();

      // 查本地账号（issuer='local'，email 唯一索引 users_local_email_uq）
      const rows = await s.db
        .select({
          id: users.id,
          email: users.email,
          passwordHash: users.passwordHash,
          status: users.status,
        })
        .from(users)
        .where(and(eq(users.issuer, 'local'), eq(users.email, email)))
        .limit(1);

      const user = rows[0];
      // 恒定时间密码校验）：用户不存在/哈希缺失也执行等量 scrypt（dummy hash），
      // 使「用户不存在」与「密码错」响应耗时一致，杜绝时序枚举。
      const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? null);

      // 正确密码豁免：只有密码错误才累计失败并可能触发单源锁定；
      // 正确密码永远放行并清零计数，攻击者无法用错误密码锁死合法账号。
      if (!user || !passwordOk) {
        const throttle = await recordLoginFailure(s.redis, 'user', email, input.ip);
        if (throttle.locked) {
          throw new FlowError('locked', {
            code: 'TOO_MANY_ATTEMPTS',
            message: '登录尝试过多，已临时锁定',
            headers: { 'retry-after': String(throttle.retryAfterSec) },
          });
        }
        throw new FlowError('invalid_credentials', { code: 'INVALID_CREDENTIALS' });
      }

      // 不区分封禁/注销：登录口统一「账号不可用」，与验码/OAuth 同语义（也避免向调用方泄露账号状态）
      if (!isAccountUsable(user.status)) {
        throw new FlowError('account_unavailable', { code: 'ACCOUNT_UNAVAILABLE' });
      }

      // 密码正确 → 清零失败计数
      await resetLoginFailures(s.redis, 'user', email, input.ip);

      // 强制邮箱验证（fail-closed）：SMTP 未配置 → 503，绝不静默降级为单密码
      if (!s.mailer) {
        throw new FlowError('mailer_unavailable', {
          code: 'TWO_FACTOR_UNAVAILABLE',
          message: '登录需邮箱验证码，但服务端未配置 SMTP——请联系管理员（不降级为单密码）',
        });
      }

      // 签发/投递/验证统一走 identity-core 挑战表（投递失败 core 自动作废，可立即重试）
      const loginCodes = createLoginCodeChallenger(s.db, { mailer: s.mailer });
      let challengeId: string;
      try {
        challengeId = await loginCodes.issue('user', {
          email: user.email ?? email,
          ip: input.ip,
        });
      } catch (e) {
        if (e instanceof LoginCodeCooldownError) {
          throw new FlowError('code_rate_limited', {
            code: 'CODE_RATE_LIMITED',
            message: '验证码发送过于频繁，请 1 分钟后再试',
            headers: { 'retry-after': '60' },
          });
        }
        if (e instanceof DeliveryFailedError) {
          throw new FlowError('code_send_failed', { code: 'CODE_SEND_FAILED' });
        }
        throw e;
      }

      return { kind: 'code_required', challengeId };
    },
  );
}

export async function verifyLoginCode(
  s: ClientServices,
  config: ClientApiConfig,
  input: { challengeId: string; code: string; ip: string },
): Promise<VerifySuccess> {
  return audited(
    s,
    {
      action: 'auth.login.verify',
      detail: () => ({ ip: input.ip }),
      targetId: (o) => (o.kind === 'success' ? o.userId : null),
    },
    async () => {
      let verified: LoginCodeVerified;
      try {
        const loginCodes = createLoginCodeChallenger(s.db, { mailer: s.mailer });
        verified = await loginCodes.verify('user', {
          challengeId: input.challengeId,
          code: input.code,
        });
      } catch (e) {
        if (e instanceof CodeVerifyError) {
          if (e.reason === 'CODE_INVALID') {
            throw new FlowError('code_invalid', { code: 'CODE_INVALID' });
          }
          throw new FlowError('challenge_invalid', {
            code: 'CHALLENGE_INVALID',
            message: '验证码已过期、不存在或错误次数过多，请重新登录',
          });
        }
        throw e;
      }
      // 挑战目标=投递邮箱 → 按邮箱绑定本地账号（唯一索引 users_local_email_uq 兜底）
      const rows = await s.db
        .select({
          id: users.id,
          email: users.email,
          status: users.status,
        })
        .from(users)
        .where(and(eq(users.issuer, 'local'), eq(users.email, verified.subjectId)))
        .limit(1);
      const user = rows[0];
      if (!user || !isAccountUsable(user.status)) {
        throw new FlowError('account_unavailable', { code: 'ACCOUNT_UNAVAILABLE' });
      }

      const session = await issueSession(s, config, user.id);
      return {
        kind: 'success',
        token: session.token,
        userId: user.id,
        email: user.email ?? '',
        gifted: session.gifted,
      };
    },
  );
}

/** 改密码：校验原密码 → 换哈希 + 会话失效线（R5-2：改密即吊销全部既有会话） */
export async function changeMyPassword(
  s: ClientServices,
  userId: number,
  input: { oldPassword: string; newPassword: string },
): Promise<void> {
  const rows = await s.db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (rows.length === 0) throw new FlowError('user_not_found', { code: 'USER_NOT_FOUND', message: '用户不存在' });

  const ok = await verifyPassword(input.oldPassword, rows[0]!.passwordHash);
  if (!ok) throw new FlowError('invalid_credentials', { code: 'INVALID_CREDENTIALS', message: '原密码错误' });

  const newHash = await hashPassword(input.newPassword);
  // R5-2：改密即吊销全部既有会话（换哈希 + 推进锚点同事务）
  await s.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(users.id, rows[0]!.id));
    await advanceAnchor(tx, 'user', rows[0]!.id, new Date());
  });
  void recordAudit(s.db, {
    actor: 'user',
    action: 'user.password_change',
    targetType: 'user',
    targetId: userId,
  });
}
