/**
 * 管理员认证服务：密码登录（可选邮箱验证码 2FA 两步流）/ 改密 / 资料 / 2FA 开关。
 *
 * 安全语义（与用户面同构，隔离在 admins 表 + type='admin' issuer）：
 *   - 登录失败统一 401（哑哈希防枚举）；爆破防护双层（装配注入，Redis 形态生效）
 *   - 2FA = 邮箱验证码（per-admin twoFactorEnabled 开关）：密码对不签会话，
 *     先发码（60s 重发冷却 / 5 次错码作废挑战）；SMTP 未配置 → 503 fail-closed，
 *     绝不静默降级为单密码
 *   - 改密原子推进会话失效线——旧 token 全网即刻失效，新 token 同拍返回
 */
import { verifyPassword, hashPassword, assertPasswordPolicy } from '@ai-gateway/identity-core';
import {
  signSession,
  createLoginCodeChallenger,
  CodeVerifyError,
  DeliveryFailedError,
  LoginCodeCooldownError,
  type Mailer,
  type LoginCodeChallenger,
} from '@ai-gateway/identity';
import { sha256Hex } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { KeyBruteForceGuard, AuthFailureGuard, GuardCheck } from '@ai-gateway/core';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import { recordAudit } from '@ai-gateway/http';

/** 密码策略（identity-core 默认口径：长度 10..128） */
const PASSWORD_POLICY = { minLength: 10, maxLength: 128 };

export interface AdminAuthServiceDeps {
  db: Db;
  repos?: Repositories;
  jwtSecret: string;
  sessionTtlSeconds: number;
  /** per-邮箱爆破锁（缺省跳过 = 单副本开发形态） */
  loginGuard: KeyBruteForceGuard;
  /** per-IP 鉴权失败锁（同上） */
  ipGuard: AuthFailureGuard;
  /** SMTP 发信（2FA 验证码的前置；null = 未配置） */
  mailer: Mailer | null;
}

export type AdminLoginResult =
  | { kind: 'success'; token: string; adminId: number }
  | { kind: 'code_required'; challengeId: string };

export interface AdminAuthService {
  login(ctx: RunContext, input: { email: string; password: string; ip: string; locale?: 'en' | 'zh' }): Promise<AdminLoginResult>;
  /** 2FA 第二步：验码签会话（状态复查 + lastLogin） */
  verifyLoginCode(
    ctx: RunContext,
    input: { challengeId: string; code: string },
  ): Promise<{ token: string; adminId: number }>;
  me(ctx: RunContext, adminId: number): Promise<{
    id: number;
    email: string;
    displayName: string | null;
    twoFactorEnabled: boolean;
    lastLoginAt: Date | null;
  }>;
  changePassword(
    ctx: RunContext,
    input: { adminId: number; oldPassword: string; newPassword: string },
  ): Promise<{ token: string }>;
  /** 2FA 开关（开启要求 SMTP 已配置——fail-closed） */
  setTwoFactorEnabled(
    ctx: RunContext,
    input: { adminId: number; enabled: boolean },
  ): Promise<{ twoFactorEnabled: boolean }>;
}

const sys = (ctx: RunContext): RunContext => ({ ...ctx, actor: { kind: 'system' } });
const asAdmin = (ctx: RunContext, adminId: number): RunContext => ({
  ...ctx,
  actor: { kind: 'admin', id: adminId },
});

/** 发码统一错误翻译（冷却 429 / 投递失败 502） */
function translateIssueError(e: unknown): never {
  if (e instanceof LoginCodeCooldownError) {
    throw new AppError(429, 'code_rate_limited', 'Verification code sent too frequently, retry in 1 minute');
  }
  if (e instanceof DeliveryFailedError) {
    throw new AppError(502, 'code_send_failed', 'Failed to send verification code, please try again later');
  }
  throw e;
}

export function createAdminAuthService(deps: AdminAuthServiceDeps): AdminAuthService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const challenger: LoginCodeChallenger | null = deps.mailer
    ? createLoginCodeChallenger(db, { mailer: deps.mailer })
    : null;

  const issue = (adminId: number) =>
    signSession(
      { type: 'admin', id: adminId, expiresInSeconds: deps.sessionTtlSeconds },
      deps.jwtSecret,
    );

  function requireChallenger(): LoginCodeChallenger {
    if (!challenger) {
      throw new AppError(503, 'two_factor_unavailable', 'Email verification code required but SMTP is not configured (no fallback to password-only login)');
    }
    return challenger;
  }

  return {
    async login(ctx, input) {
      const email = input.email.trim().toLowerCase();
      // 锁维度 = (email, ip) 且正确密码永远放行（与用户面同语义：纯 email 锁可被
      // 匿名攻击者用于锁死管理员 = 把爆破锁变成 DoS 开关）
      const guardKey = sha256Hex(`${email}:${input.ip}`);

      // 爆破锁状态读取（Redis 必配；不可达 fail-closed 503）——锁不前置拒绝
      let byKey: GuardCheck, byIp: GuardCheck;
      try {
        [byKey, byIp] = await Promise.all([
          deps.loginGuard.isLocked(guardKey),
          deps.ipGuard.isLocked(input.ip),
        ]);
      } catch {
        throw new AppError(503, 'auth_guard_unavailable', 'Auth guard unavailable, please try again later');
      }

      const account = await repos.adminAccount.findByEmail({ db, ...sys(ctx) }, email);
      // 哑哈希：账号不存在也做等量 scrypt 计算（响应耗时一致——防枚举）
      const ok = await verifyPassword(input.password, account?.passwordHash ?? null);
      if (!ok || !account) {
        await Promise.all([
          deps.loginGuard.recordFailure(guardKey).catch(() => undefined),
          deps.ipGuard.recordFailure(input.ip).catch(() => undefined),
        ]);
        // 管理面登录失败必留审计（安全事件取证主观察点）
        await recordAudit(deps.db, {
          actor: 'system',
          action: 'auth.login.invalid_credentials',
          targetType: 'admin',
          targetId: account?.id ?? null,
          detail: { email, ip: input.ip },
        }).catch(() => undefined);
        const retry = byKey.locked ? byKey.retryAfterSec : byIp.locked ? byIp.retryAfterSec : 0;
        if (retry > 0) {
          throw new AppError(429, 'login_locked', 'Too many attempts, please try again later', {
            'retry-after': String(Math.max(1, retry)),
          });
        }
        throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
      }
      if (account.status !== 0) {
        throw new AppError(403, 'account_unavailable', 'Account unavailable');
      }
      await Promise.all([
        deps.loginGuard.recordSuccess(guardKey).catch(() => undefined),
        deps.ipGuard.recordSuccess?.(input.ip).catch(() => undefined),
      ]);

      // 2FA：密码对不签会话，发码走第二步
      if (account.twoFactorEnabled) {
        const codes = requireChallenger();
        try {
          const challengeId = await codes.issue('admin', {
            email: account.email,
            ip: input.ip,
            locale: input.locale,
          });
          await recordAudit(deps.db, {
            actor: 'system',
            action: 'auth.login.2fa_challenge',
            targetType: 'admin',
            targetId: account.id,
            detail: { ip: input.ip },
          }).catch(() => undefined);
          return { kind: 'code_required', challengeId };
        } catch (e) {
          translateIssueError(e);
        }
      }

      await repos.adminAccount.touchLastLogin({ db, ...sys(ctx) }, account.id);
      await recordAudit(deps.db, {
        actor: 'system',
        action: 'auth.login.success',
        targetType: 'admin',
        targetId: account.id,
        detail: { ip: input.ip },
      }).catch(() => undefined);
      return { kind: 'success', token: await issue(account.id), adminId: account.id };
    },

    async verifyLoginCode(ctx, input) {
      const codes = requireChallenger();
      let verified;
      try {
        verified = await codes.verify('admin', { challengeId: input.challengeId, code: input.code });
      } catch (e) {
        if (e instanceof CodeVerifyError) {
          if ((e as { reason?: string }).reason === 'CODE_INVALID') {
            throw new AppError(401, 'code_invalid', 'Invalid verification code');
          }
          throw new AppError(400, 'challenge_invalid', 'Verification code expired or too many failed attempts, please log in again');
        }
        throw e;
      }
      const email = verified.subjectId.trim().toLowerCase();
      const account = await repos.adminAccount.findByEmail({ db, ...sys(ctx) }, email);
      if (!account) throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
      if (account.status !== 0) throw new AppError(403, 'account_unavailable', 'Account unavailable');
      await repos.adminAccount.touchLastLogin({ db, ...sys(ctx) }, account.id);
      await recordAudit(deps.db, {
        actor: 'system',
        action: 'auth.login.success',
        targetType: 'admin',
        targetId: account.id,
        detail: { twoFactor: true },
      }).catch(() => undefined);
      return { token: await issue(account.id), adminId: account.id };
    },

    async me(ctx, adminId) {
      const account = await repos.adminAccount.findById({ db, ...asAdmin(ctx, adminId) }, adminId);
      if (!account) throw new AppError(401, 'unauthorized', 'Account not found');
      return {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        twoFactorEnabled: account.twoFactorEnabled,
        lastLoginAt: account.lastLoginAt,
      };
    },

    async changePassword(ctx, input) {
      const runCtx = asAdmin(ctx, input.adminId);
      const account = await repos.adminAccount.findById({ db, ...runCtx }, input.adminId);
      if (!account) throw new AppError(401, 'unauthorized', 'Account not found');

      const ok = await verifyPassword(input.oldPassword, account.passwordHash);
      if (!ok || account.status !== 0) {
        throw new AppError(401, 'invalid_credentials', 'Current password is incorrect');
      }
      assertPasswordPolicy(input.newPassword, PASSWORD_POLICY);

      const passwordHash = await hashPassword(input.newPassword);
      // 失效线 = 现在；新 token 在事务提交后签发，iat 严格在线后（见 signSession iatMs）
      const invalidBefore = new Date();
      const updated = await repos.adminAccount.updatePassword({ db, ...runCtx }, {
        adminId: input.adminId,
        passwordHash,
        invalidBefore,
      });
      if (!updated) throw new AppError(401, 'unauthorized', 'Account not found');
      return { token: await issue(input.adminId) };
    },

    async setTwoFactorEnabled(ctx, input) {
      if (input.enabled && !deps.mailer) {
        throw new AppError(400, 'smtp_not_configured', 'Enabling two-factor authentication requires SMTP configuration first');
      }
      const runCtx = asAdmin(ctx, input.adminId);
      const updated = await repos.adminAccount.setTwoFactorEnabled({ db, ...runCtx }, {
        adminId: input.adminId,
        enabled: input.enabled,
      });
      if (!updated) throw new AppError(404, 'admin_not_found', 'Admin not found');
      return { twoFactorEnabled: input.enabled };
    },
  };
}
