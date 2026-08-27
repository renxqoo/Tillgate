/**
 * 登录动词（公开）：爆破双闸（邮箱+IP / IP）包裹 identity 鉴别（内部防枚举统一
 * 401）→ 账户状态闸 → 两级登录开关（发码）或直签会话；login/verify 凭 uid 载荷
 * 免二次鉴别后签发。失败计数 best-effort，成功清零。
 */
import { Hono } from 'hono';
import { isBusinessError } from '@tillgate/errors';
import { jsonBody } from '@tillgate/http';
import { USER_STATUS } from '@tillgate/accounts';
import { identityErrors } from '@tillgate/identity';
import { loginSchema, verifySchema } from '../contracts/auth.js';
import { clientErrors } from '../error-face.js';
import type { SessionEnv } from '../middleware/session.js';
import { clientIpOf, guardKeyOf, localeOf, type AuthDeps } from './auth.js';

/** 登录期挑战载荷（uid 供 verify 半程免二次认证） */
interface LoginPayload {
  uid: number;
}

// eslint-disable-next-line max-lines-per-function -- 登录族装配平铺:路由表+多级登录处理器平铺
export function loginRoutes(deps: AuthDeps) {
  const app = new Hono<SessionEnv>();

  // eslint-disable-next-line max-lines-per-function -- 凭证登录链(守卫闸/鉴别/防枚举/状态/计数)语义连续,拆段即互相回读
  app.post('/v1/auth/login', jsonBody(loginSchema), async (c) => {
    const body = c.req.valid('json');
    const ip = clientIpOf(deps, c);
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
      throw clientErrors.business('login_locked', undefined, {
        retryAfterMs: retryAfterSec * 1000,
      });
    }
    let userId: number;
    try {
      ({ userId } = await deps.authenticate({
        identifier: { kind: 'email', value: body.email },
        password: body.password,
      }));
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
    if (deps.capabilities().emailCodeRequired) {
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
    await deps.touchLastLogin(userId).catch(() => {});
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
    await deps.touchLastLogin(userId).catch(() => {});
    return c.json({ token, userId });
  });

  return app;
}
