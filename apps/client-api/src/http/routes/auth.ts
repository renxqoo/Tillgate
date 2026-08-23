/**
 * 认证路由（公开 + 会话）：注册/登录两步验证码流 / 验码 / 登出 / 改密 / 能力探测。
 * 本层只编排 facade 动词与协议闸（限频/守卫/防枚举口径）——业务规则单源在
 * identity/accounts（DESIGN §4）。挑战载荷只存 cipher 封装后的密码，永不落明文。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { isBusinessError } from '@tokenlens/errors';
import { parseAcceptLanguage, socketAddressFromContext, trustedClientIp } from '@tokenlens/http';
import { AccountsErrors, USER_STATUS } from '@tokenlens/accounts';
import { jsonBody } from '@tokenlens/http';
import { sha256Hex } from '@tokenlens/billing';
import {
  assertPasswordPolicy,
  identityErrors,
  type Identity,
  type PasswordPolicy,
} from '@tokenlens/identity';
import type { AuthFailureGuard, KeyBruteForceGuard } from '@tokenlens/runtime';
import { registerSchema, loginSchema, verifySchema, passwordSchema } from '../contracts/auth.js';
import { clientErrors } from '../error-face.js';
import type { SessionEnv } from '../middleware/session.js';

/** 前端能力探测（登录/注册页按钮渲染依据；无个人数据） */
export interface ClientCapabilities {
  readonly registerEnabled: boolean;
  readonly captchaSiteKey: string | null;
  readonly emailCodeRequired: boolean;
}

/** 密码信封：注册期封装进挑战载荷、验码期开封（挑战库不落明文——v1「只存哈希」的等价保持） */
export interface PasswordSealer {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/** 注册期挑战载荷（identity challenges.payload 的 app 形状） */
interface RegisterPayload {
  mail: string;
  aff: string | null;
  pwd: string;
}

/** 登录期挑战载荷（uid 供 verify 半程免二次认证） */
interface LoginPayload {
  uid: number;
}

export interface AuthDeps {
  readonly capabilities: ClientCapabilities;
  readonly passwordPolicy: PasswordPolicy;
  readonly sealer: PasswordSealer;
  readonly trustedProxyHops: number;
  /** captcha 未配置（siteKey null）时为 null——探测/校验整体关闭 */
  readonly captcha: Pick<Identity['captcha'], 'verify'> | null;
  readonly registerLimiter: { hit(key: string, windowSeconds: number): Promise<number> };
  readonly registerIpLimitPerHour: number;
  readonly emailTaken: (email: string) => Promise<boolean>;
  readonly challenges: Pick<Identity['challenges'], 'begin' | 'verify'>;
  readonly registerCredential: Identity['credentials']['register'];
  readonly provision: (input: { email: string }) => Promise<{ id: number; email: string | null }>;
  readonly onboarding: (input: { userId: number; affCode?: string }) => Promise<{ gift: { status: string } }>;
  readonly authenticate: Identity['passwords']['authenticate'];
  readonly changePassword: Identity['passwords']['change'];
  readonly guards: { emailIp: KeyBruteForceGuard; ip: AuthFailureGuard };
  readonly userStatus: (userId: number) => Promise<number | null>;
  readonly touchLastLogin: (userId: number) => Promise<void>;
  readonly sign: (userId: number) => Promise<string>;
  readonly logout: (token: string) => Promise<void>;
}

function bearerToken(header: string | undefined): string {
  return header != null && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/** 爆破守卫键：邮箱+IP 双维（v1 口径） */
function guardKeyOf(email: string, ip: string): string {
  return sha256Hex(`${email}:${ip}`);
}

/** Accept-Language → identity delivery locale（'zh' 之外一律 en） */
function localeOf(c: Parameters<MiddlewareHandler<SessionEnv>>[0]): 'en' | 'zh' {
  return parseAcceptLanguage(c.req.header('accept-language')) === 'zh' ? 'zh' : 'en';
}

export function authRoutes(deps: AuthDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();
  // 真实 socket 对端地址必须注入：置 null 时全部请求落到进程级常量桶——
  // 注册限频与登录 IP 锁退化为「全站一个桶」的自伤开关（app.request 测试 → null 合法）
  const clientIp = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
    trustedClientIp({
      headers: c.req.raw.headers,
      trustedProxyHops: deps.trustedProxyHops,
      socketAddress: socketAddressFromContext(c),
    });

  app.get('/v1/auth/capabilities', (c) => c.json(deps.capabilities));

  app.post('/v1/auth/logout', session, async (c) => {
    await deps.logout(bearerToken(c.req.header('authorization')));
    return c.json({ ok: true });
  });

  app.post('/v1/auth/register', jsonBody(registerSchema), async (c) => {
    const body = c.req.valid('json');
    const ip = clientIp(c);
    if (!deps.capabilities.registerEnabled) {
      throw clientErrors.business('register_disabled');
    }
    let hits: number;
    try {
      hits = await deps.registerLimiter.hit(`register:${ip}`, 3_600);
    } catch {
      throw clientErrors.business('rate_counter_unavailable');
    }
    if (hits > deps.registerIpLimitPerHour) {
      throw clientErrors.business('register_rate_limited', undefined, { retryAfterMs: 3_600_000 });
    }
    if (deps.captcha != null && deps.capabilities.captchaSiteKey != null) {
      if (body.captchaToken == null) {
        throw clientErrors.business('captcha_required');
      }
      // 判负/不可达由 identity 翻译为业务错误（captcha_invalid 400 / captcha_unavailable 503）
      await deps.captcha.verify({ token: body.captchaToken, remoteIp: ip ?? undefined });
    }
    if (await deps.emailTaken(body.email)) {
      throw AccountsErrors.business('email_taken', { email: body.email });
    }
    // 密码策略单源校验（identity 域；不满足直接 400——v1 在发码前拒绝）
    assertPasswordPolicy(body.password, deps.passwordPolicy);
    const payload: Record<string, unknown> = {
      mail: body.email,
      aff: body.aff ?? null,
      pwd: deps.sealer.seal(body.password),
    };
    const { challengeId } = await deps.challenges.begin({
      kind: 'email_code',
      target: { identifier: { kind: 'email', value: body.email } },
      payload,
      delivery: { ip: ip ?? 'unknown', locale: localeOf(c) },
    });
    return c.json({ kind: 'code_required', challengeId });
  });

  app.post('/v1/auth/register/verify', jsonBody(verifySchema), async (c) => {
    const body = c.req.valid('json');
    if (!deps.capabilities.registerEnabled) {
      throw clientErrors.business('register_disabled');
    }
    const verified = await deps.challenges.verify({
      challengeId: body.challengeId,
      code: body.code,
    });
    const payload = (verified.payload ?? {}) as Partial<RegisterPayload>;
    if (payload.mail == null || payload.pwd == null) {
      // 挑战载荷损坏 = 装配期坏流（非用户错误），显式 503 不静默吞
      throw clientErrors.business('two_factor_unavailable');
    }
    const user = await deps.provision({ email: payload.mail });
    await deps.registerCredential({
      userId: user.id,
      identifier: { kind: 'email', value: payload.mail },
      password: deps.sealer.open(payload.pwd),
    });
    const onboarding = await deps.onboarding({
      userId: user.id,
      affCode: body.aff ?? payload.aff ?? undefined,
    });
    const token = await deps.sign(user.id);
    return c.json(
      {
        kind: 'success',
        token,
        userId: user.id,
        email: user.email ?? payload.mail,
        gifted: onboarding.gift.status === 'credited',
      },
      201,
    );
  });

  app.post('/v1/auth/login', jsonBody(loginSchema), async (c) => {
    const body = c.req.valid('json');
    const ip = clientIp(c);
    const guardKey = guardKeyOf(body.email, ip);
    let emailLock: { locked: boolean; retryAfterSec: number };
    let ipLock: { locked: boolean; retryAfterSec: number };
    try {
      [emailLock, ipLock] = await Promise.all([
        deps.guards.emailIp.isLocked(guardKey),
        deps.guards.ip.isLocked(ip),
      ]);
    } catch {
      throw clientErrors.business('auth_guard_unavailable');
    }
    if (emailLock.locked || ipLock.locked) {
      const retryAfterSec = Math.max(1, emailLock.retryAfterSec, ipLock.retryAfterSec);
      throw clientErrors.business('login_locked', undefined, { retryAfterMs: retryAfterSec * 1000 });
    }
    let userId: number;
    try {
      userId = (
        await deps.authenticate({
          identifier: { kind: 'email', value: body.email },
          password: body.password,
        })
      ).userId;
    } catch (error) {
      // 防枚举统一 401（identity invalid_credentials）；失败计数双闸 best-effort
      if (!isBusinessError(error) || error.code !== 'identity.invalid_credentials') throw error;
      await Promise.allSettled([
        deps.guards.emailIp.recordFailure(guardKey),
        deps.guards.ip.recordFailure(ip),
      ]);
      throw error;
    }
    const status = await deps.userStatus(userId);
    if (status == null) {
      await Promise.allSettled([
        deps.guards.emailIp.recordFailure(guardKey),
        deps.guards.ip.recordFailure(ip),
      ]);
      throw identityErrors.business('invalid_credentials', { realm: 'user' });
    }
    if (status !== USER_STATUS.ACTIVE) {
      throw clientErrors.business('account_unavailable');
    }
    await Promise.allSettled([
      deps.guards.emailIp.recordSuccess(guardKey),
      ...(deps.guards.ip.recordSuccess != null ? [deps.guards.ip.recordSuccess(ip)] : []),
    ]);
    if (deps.capabilities.emailCodeRequired) {
      const payload: Record<string, unknown> = { uid: userId };
      const { challengeId } = await deps.challenges.begin({
        kind: 'email_code',
        target: { identifier: { kind: 'email', value: body.email } },
        payload,
        delivery: { ip: ip ?? 'unknown', locale: localeOf(c) },
      });
      return c.json({ kind: 'code_required', challengeId });
    }
    const token = await deps.sign(userId);
    await deps.touchLastLogin(userId).catch(() => undefined);
    return c.json({ kind: 'success', token, userId });
  });

  app.post('/v1/auth/login/verify', jsonBody(verifySchema), async (c) => {
    const body = c.req.valid('json');
    const verified = await deps.challenges.verify({
      challengeId: body.challengeId,
      code: body.code,
    });
    const payload = (verified.payload ?? {}) as Partial<LoginPayload>;
    const userId = payload.uid;
    if (userId == null) {
      throw identityErrors.business('invalid_credentials', { realm: 'user' });
    }
    const status = await deps.userStatus(userId);
    if (status == null) {
      throw identityErrors.business('invalid_credentials', { realm: 'user' });
    }
    if (status !== USER_STATUS.ACTIVE) {
      throw clientErrors.business('account_unavailable');
    }
    const token = await deps.sign(userId);
    await deps.touchLastLogin(userId).catch(() => undefined);
    return c.json({ token, userId });
  });

  app.post('/v1/auth/password', session, jsonBody(passwordSchema), async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await deps.changePassword({
      userId,
      realm: 'user',
      currentPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    // 改密即吊销全部旧会话；当场重签返回新 token（v1 口径）
    const token = await deps.sign(userId);
    return c.json({ token });
  });

  return app;
}
