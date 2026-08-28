/**
 * 管理员认证路由：登录（可选 2FA 邮箱码两步流）/验码/登出。
 * 编排语义：
 *   - 爆破双闸（(email,ip) 哈希键 + ip）= runtime Redis 守卫;不可达 fail-closed 503;
 *     锁维度 (email,ip) 且正确密码永远放行——纯 email 锁可被匿名者用于锁死管理员（DoS 开关）
 *   - 密码鉴别 = identity.passwords.authenticate（哑哈希防枚举,统一 401）
 *   - 2FA = per-admin 开关:密码对不签会话,先发码（identity challenges,kind
 *     admin_login_code）;SMTP 未配置 → 503 fail-closed,绝不静默降级单密码
 *   - 登录三审计（invalid_credentials/2fa_challenge/success）= observability 后置审计
 *   - 登出 = identity.sessions.logout（jti 入吊销面——泄露副本即刻失效）
 * Bearer 会话——无 Cookie 无 CSRF;客户端自持 token。公开组（登录/验码）不挂会话件。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { isBusinessError } from '@tillgate/errors';
import { sha256Hex } from '@tillgate/billing';
import {
  jsonBody,
  socketAddressFromContext,
  trustedClientIp,
  parseAcceptLanguage,
} from '@tillgate/http';
import type { Identity } from '@tillgate/identity';
import type { ControlPlane } from '@tillgate/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { authContracts } from '../contracts/auth';
import type { AdminInvitePort } from './admins';

/** 爆破守卫形状（runtime createKeyBruteForceGuard/createAuthFailureGuard 产物;
 * ip 守卫的 recordSuccess 可选——AuthFailureGuard 形态） */
export interface AuthGuard {
  isLocked(key: string): Promise<{ locked: boolean; retryAfterSec: number }>;
  recordFailure(key: string): Promise<unknown>;
  recordSuccess?(key: string): Promise<unknown>;
}

export interface AuthRoutesDeps {
  readonly identity: Pick<Identity, 'passwords' | 'challenges' | 'sessions' | 'mfa'>;
  readonly admins: Pick<ControlPlane['admins'], 'findByEmail' | 'find' | 'touchLastLogin'>;
  readonly guards: { emailIp: AuthGuard; ip: AuthGuard };
  /** 登录三审计（后置旁路,失败不阻断——best-effort） */
  readonly loginAudit: (entry: {
    action: 'auth.login.invalid_credentials' | 'auth.login.2fa_challenge' | 'auth.login.success';
    adminId: number | null;
    ip: string | null;
    email?: string;
    twoFactor?: boolean;
  }) => Promise<void>;
  readonly trustedProxyHops: number;
  /** SMTP 是否已配置（2FA 开启前置——fail-closed,不静默降级） */
  readonly mailerConfigured: () => boolean;
  /** 邀请令牌消费面（POST /v1/auth/reset-password——新建管理员设置初始密码） */
  readonly invites: Pick<AdminInvitePort, 'consume'>;
  readonly sessionTtlSec: number;
}

/** 2FA 半程载荷：verify 免二次鉴别（identity 挑战 payload 单一载体） */
interface LoginPayload {
  adminId: number;
}

/** 邀请令牌统一拒绝(无效/过期/已用/已激活/封禁——同一口径,不泄漏原因) */
const invalidResetToken = () => AdminErrors.business('admin_reset_token_invalid', {});

// eslint-disable-next-line max-lines-per-function -- 登录族装配平铺:路由表 + 凭证鉴别/2FA 共享闭包保留存量语义(棘轮)
export function authRoutes(deps: AuthRoutesDeps) {
  const app = new Hono<SessionEnv>();

  const clientIpOf = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops,
      // 真实 socket 地址（null = 全进程共享一桶——30 次失败锁死所有管理员,DoS 放大器）
      socketAddress: socketAddressFromContext(c),
    });

  const requireMailer = (): void => {
    if (!deps.mailerConfigured()) {
      throw AdminErrors.business('two_factor_unavailable', {});
    }
  };

  /** 凭证鉴别共享段（login 与 login/totp 同口径）:守卫闸 → 密码 → 资料漂移 →
   *  状态 → 成功清零计数;失败计双闸 + 审计。返回 adminId,拒绝路径统一抛业务错 */
  // eslint-disable-next-line max-lines-per-function -- 凭证鉴别链(守卫/密码/漂移/状态/计数/审计)语义连续,拆段即互相回读
  const authenticateCredentials = async (
    body: { email: string; password: string },
    ip: string,
  ): Promise<{
    adminId: number;
    account: NonNullable<Awaited<ReturnType<AuthRoutesDeps['admins']['findByEmail']>>>;
  }> => {
    const guardKey = sha256Hex(`${body.email}:${ip}`);

    // 守卫不可达 fail-closed（Redis 必配）
    let byKey: { locked: boolean; retryAfterSec: number };
    let byIp: { locked: boolean; retryAfterSec: number };
    try {
      [byKey, byIp] = await Promise.all([
        deps.guards.emailIp.isLocked(guardKey),
        deps.guards.ip.isLocked(ip),
      ]);
    } catch {
      throw AdminErrors.business('auth_guard_unavailable', {});
    }

    let adminId: number;
    try {
      adminId = (
        await deps.identity.passwords.authenticate({
          identifier: { kind: 'email', value: body.email },
          password: body.password,
        })
      ).userId;
    } catch (error) {
      if (!isBusinessError(error) || error.code !== 'identity.invalid_credentials') throw error;
      // 失败计数双闸 best-effort;审计（安全事件取证主观察点）
      await Promise.allSettled([
        deps.guards.emailIp.recordFailure(guardKey),
        deps.guards.ip.recordFailure(ip),
        deps.loginAudit({
          action: 'auth.login.invalid_credentials',
          adminId: null,
          ip,
          email: body.email,
        }),
      ]);
      let retry = 0;
      if (byKey.locked) retry = byKey.retryAfterSec;
      else if (byIp.locked) retry = byIp.retryAfterSec;
      if (retry > 0) {
        throw AdminErrors.business('login_locked', {
          'retry-after': String(Math.max(1, retry)),
        });
      }
      throw error;
    }

    const account = await deps.admins.findByEmail(body.email);
    if (account == null || account.id !== adminId) {
      // 凭据行与资料行漂移（迁移不完整）——按凭据不存在口径统一 401,不泄漏状态
      throw AdminErrors.business('invalid_credentials_admin', {});
    }
    if (account.status !== 0) {
      throw AdminErrors.business('account_unavailable', {});
    }

    await Promise.allSettled([
      deps.guards.emailIp.recordSuccess?.(guardKey) ?? Promise.resolve(),
      ...(deps.guards.ip.recordSuccess != null ? [deps.guards.ip.recordSuccess(ip)] : []),
    ]);
    return { adminId, account };
  };

  app.post('/v1/auth/logout', async (c) => {
    await deps.identity.sessions.logout(c.get('sessionToken'), 'admin');
    return c.json({ ok: true });
  });

  // 消费邀请令牌设置初始密码(公开端点——ACL PUBLIC_ROUTES 直通):
  // 校验链任一失败统一 400 admin_reset_token_invalid(不泄漏具体原因——令牌
  // 无枚举面,但「目标已激活」与「封禁」等状态不外泄);成功不自动登录
  // (对齐 C 端找回交互,跳登录页手动登录)。旧链接在对方设密后即作废
  // (消费期「目标无密码」校验——泄露链接改不了已激活账号的密码)。
  app.post('/v1/auth/reset-password', jsonBody(authContracts.resetPassword), async (c) => {
    const body = c.req.valid('json');
    const adminId = await deps.invites.consume(body.token);
    if (adminId == null) throw invalidResetToken();
    const account = await deps.admins.find(adminId);
    if (account == null || account.status !== 0) throw invalidResetToken();
    const activated = await deps.identity.passwords.exists({ userIds: [adminId] });
    if (activated.length > 0) throw invalidResetToken();
    await deps.identity.passwords.reset({
      userId: adminId,
      realm: 'admin',
      newPassword: body.password,
    });
    return c.json({ ok: true });
  });

  app.post('/v1/auth/login', async (c) => {
    const body = authContracts.login.parse(await c.req.json());
    const ip = clientIpOf(c);
    const { adminId, account } = await authenticateCredentials(body, ip);

    // 第二因子择路:TOTP 绑定即接管(不退回邮箱码——防降级);否则邮箱码(旧形态)
    const totp = await deps.identity.mfa.status({ userId: adminId });
    if (totp.confirmed) {
      await deps
        .loginAudit({ action: 'auth.login.2fa_challenge', adminId, ip, twoFactor: true })
        .catch(() => {});
      return c.json({ twoFactorRequired: true, method: 'totp' });
    }

    // 2FA：密码对不签会话,发码走第二步
    if (account?.twoFactorEnabled) {
      requireMailer();
      const { challengeId } = await deps.identity.challenges.begin({
        kind: 'admin_login_code',
        target: { identifier: { kind: 'email', value: body.email } },
        payload: { adminId } satisfies LoginPayload,
        delivery: {
          ip: ip ?? 'unknown',
          locale:
            parseAcceptLanguage(c.req.header('accept-language')) === 'zh'
              ? ('zh' as const)
              : ('en' as const),
        },
      });
      await deps
        .loginAudit({
          action: 'auth.login.2fa_challenge',
          adminId,
          ip,
        })
        .catch(() => {});
      return c.json({ twoFactorRequired: true, method: 'email', challengeId });
    }

    await deps.admins.touchLastLogin(adminId);
    await deps.loginAudit({ action: 'auth.login.success', adminId, ip }).catch(() => {});
    return c.json({
      token: await deps.identity.sessions.sign({
        realm: 'admin',
        subjectId: adminId,
        ttlSec: deps.sessionTtlSec,
      }),
      adminId,
    });
  });

  // TOTP 第二步:无挑战行(验证无状态、防重放在 identity lastUsedStep CAS)——
  // 重验凭证(守卫/密码/状态同一口径,失败同样计数)+ 验证器/恢复码
  app.post('/v1/auth/login/totp', jsonBody(authContracts.loginTotp), async (c) => {
    const body = c.req.valid('json');
    const ip = clientIpOf(c);
    const { adminId } = await authenticateCredentials(body, ip);
    const totp = await deps.identity.mfa.status({ userId: adminId });
    if (!totp.confirmed) {
      // 未绑定却走 TOTP 端点 = 状态漂移(绑定后解绑的两步窗口),按凭据不存在口径
      throw AdminErrors.business('invalid_credentials_admin', {});
    }
    try {
      await deps.identity.mfa.verify({ userId: adminId, code: body.code });
    } catch (error) {
      if (!isBusinessError(error)) throw error;
      // 码错同计失败闸(6 位码空间小,必须限速爆破)
      const guardKey = sha256Hex(`${body.email}:${ip}`);
      await Promise.allSettled([
        deps.guards.emailIp.recordFailure(guardKey),
        deps.guards.ip.recordFailure(ip),
      ]);
      throw error;
    }
    await deps.admins.touchLastLogin(adminId);
    await deps
      .loginAudit({ action: 'auth.login.success', adminId, ip, twoFactor: true })
      .catch(() => {});
    return c.json({
      token: await deps.identity.sessions.sign({
        realm: 'admin',
        subjectId: adminId,
        ttlSec: deps.sessionTtlSec,
      }),
      adminId,
    });
  });

  app.post('/v1/auth/login/verify', async (c) => {
    const body = authContracts.verify.parse(await c.req.json());
    const verified = await deps.identity.challenges.verify({
      challengeId: body.challengeId,
      code: body.code,
    });
    const payload = (verified.payload ?? {}) as Partial<LoginPayload>;
    const { adminId } = payload;
    if (adminId == null) {
      throw AdminErrors.business('invalid_credentials_admin', {});
    }
    // 状态复查（封禁发生在两步之间——窗口关闭）
    const account = await deps.admins.find(adminId);
    if (account == null || account.status !== 0) {
      throw AdminErrors.business('account_unavailable', {});
    }
    await deps.admins.touchLastLogin(adminId);
    await deps
      .loginAudit({
        action: 'auth.login.success',
        adminId,
        ip: null,
        twoFactor: true,
      })
      .catch(() => {});
    return c.json({
      token: await deps.identity.sessions.sign({
        realm: 'admin',
        subjectId: adminId,
        ttlSec: deps.sessionTtlSec,
      }),
      adminId,
    });
  });

  return app;
}
