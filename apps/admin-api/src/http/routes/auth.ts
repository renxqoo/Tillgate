/**
 * 管理员认证路由（P2;v1 routes/auth.ts 平移）：登录（可选 2FA 邮箱码两步流）/验码/登出。
 * 编排语义（v1 auth.service 逐条映射 v2 能力包）：
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
import { isBusinessError } from '@tokenlens/errors';
import { sha256Hex } from '@tokenlens/billing';
import { socketAddressFromContext, trustedClientIp, parseAcceptLanguage } from '@tokenlens/http';
import type { Identity } from '@tokenlens/identity';
import type { ControlPlane } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { authContracts } from '../contracts/auth';

/** 爆破守卫形状（runtime createKeyBruteForceGuard/createAuthFailureGuard 产物;
 * ip 守卫的 recordSuccess 可选——AuthFailureGuard 形态） */
export interface AuthGuard {
  isLocked(key: string): Promise<{ locked: boolean; retryAfterSec: number }>;
  recordFailure(key: string): Promise<unknown>;
  recordSuccess?(key: string): Promise<unknown>;
}

export interface AuthRoutesDeps {
  readonly identity: Pick<Identity, 'passwords' | 'challenges' | 'sessions'>;
  readonly admins: Pick<ControlPlane['admins'], 'findByEmail' | 'find' | 'touchLastLogin'>;
  readonly guards: { emailIp: AuthGuard; ip: AuthGuard };
  /** 登录三审计（后置旁路,失败不阻断——v1 recordAudit best-effort 语义） */
  readonly loginAudit: (entry: {
    action: 'auth.login.invalid_credentials' | 'auth.login.2fa_challenge' | 'auth.login.success';
    adminId: number | null;
    ip: string | null;
    email?: string;
    twoFactor?: boolean;
  }) => Promise<void>;
  readonly trustedProxyHops: number;
  /** SMTP 是否已配置（2FA 开启前置——fail-closed,不静默降级） */
  readonly mailerConfigured: boolean;
  readonly sessionTtlSec: number;
}

/** 2FA 半程载荷：verify 免二次鉴别（identity 挑战 payload 单一载体） */
interface LoginPayload {
  adminId: number;
}

export function authRoutes(deps: AuthRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  const clientIpOf = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops,
      // 真实 socket 地址（null = 全进程共享一桶——30 次失败锁死所有管理员,DoS 放大器）
      socketAddress: socketAddressFromContext(c),
    });

  const requireMailer = (): void => {
    if (!deps.mailerConfigured) {
      throw AdminErrors.business('two_factor_unavailable', {});
    }
  };

  app.post('/v1/auth/logout', session, async (c) => {
    await deps.identity.sessions.logout(c.get('sessionToken'), 'admin');
    return c.json({ ok: true });
  });
  app.post('/v1/auth/login', async (c) => {
    const body = authContracts.login.parse(await c.req.json());
    const ip = clientIpOf(c);
    const guardKey = sha256Hex(`${body.email}:${ip}`);

    // 守卫不可达 fail-closed（Redis 必配,P2 起）
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
      const retry = byKey.locked ? byKey.retryAfterSec : byIp.locked ? byIp.retryAfterSec : 0;
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
      deps.guards.ip.recordSuccess?.(ip) ?? Promise.resolve(),
    ]);

    // 2FA：密码对不签会话,发码走第二步
    if (account.twoFactorEnabled) {
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
        .catch(() => undefined);
      return c.json({ twoFactorRequired: true, challengeId });
    }

    await deps.admins.touchLastLogin(adminId);
    await deps.loginAudit({ action: 'auth.login.success', adminId, ip }).catch(() => undefined);
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
    const adminId = payload.adminId;
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
      .catch(() => undefined);
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
