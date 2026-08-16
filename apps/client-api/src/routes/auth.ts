import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { users } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  hashPassword,
  verifyPassword,
  SESSION_COOKIE,
  SESSION_DEFAULT_TTL_S,
  cookieOptions,
  type ClientEnv,
} from '@ai-gateway/identity';
import { clientIpFromContext, csrfProtection, HttpError, jsonBody, recordAudit } from '@ai-gateway/http';
import type { ClientServices } from '../services/index.js';
import { login, verifyLoginCode, register, verifyRegistration } from '../services/auth.js';
import type { ClientApiConfig } from '../config.js';

/**
 * 用户面会话与登录（api-contract §4.1 / §5）。
 *
 * 公开端点（挂载于 /api/auth）：
 *   - POST /login：邮箱 + 密码 → 发 6 位邮箱验证码（强制两步，60s 冷却/账号）
 *   - POST /login/verify：验证码通过 → 签发 HttpOnly Cookie 会话 JWT（24h，type='user'）
 *   - POST /logout：清 Cookie
 *
 * 受保护端点（挂载于受保护子应用 /auth）：
 *   - POST /password：修改自己的密码（已登录用户）
 */

const loginSchema = z.object({
  /** 登录标识：本地账号 email（issuer='local'，DB 唯一索引 users_local_email_uq） */
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8, '密码至少 8 位').max(128),
});

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(128),
});

export function clientAuthRoutesPublic(s: ClientServices, config: ClientApiConfig): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    // 登录/验码/登出同样过 CSRF 校验（C7 收口）：跨站表单不能强制受害者登录攻击者账号/被登出。
    // 合法浏览器登录带受信 Origin；脚本/SDK 双缺失头按 INTERNAL_API_TOKEN 兼容规则处理。
    .use(csrfProtection({ trustedOrigins: config.trustedOrigins, internalToken: config.internalApiToken }))

    // 第一步：邮箱 + 密码 → 发验证码（不签会话）
    .post('/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIpFromContext(c, config);
      const outcome = await login(s, config, { email: body.email, password: body.password, ip });

      // 登录审计（旁路）：成功/失败/锁定均落 audit_logs
      void recordAudit(s.db, {
        actor: 'user',
        action: `auth.login.${outcome.kind}`,
        targetType: 'user',
        targetId: null,
        detail: { email: body.email.slice(0, 64), ip },
      });

      switch (outcome.kind) {
        case 'locked':
          throw new HttpError('TOO_MANY_ATTEMPTS', '登录尝试过多，已临时锁定', undefined, {
            'retry-after': String(outcome.retryAfterSec),
          });
        case 'invalid_credentials':
          throw new HttpError('INVALID_CREDENTIALS');
        case 'banned':
          throw new HttpError('ACCOUNT_BANNED');
        case 'deleted':
          throw new HttpError('ACCOUNT_DELETED');
        case 'mailer_unavailable':
          throw new HttpError(
            'TWO_FACTOR_UNAVAILABLE',
            '登录需邮箱验证码，但服务端未配置 SMTP——请联系管理员（不降级为单密码）',
          );
        case 'code_rate_limited':
          throw new HttpError('CODE_RATE_LIMITED', '验证码发送过于频繁，请 1 分钟后再试', undefined, {
            'retry-after': String(outcome.retryAfterSec),
          });
        case 'code_send_failed':
          throw new HttpError('CODE_SEND_FAILED');
        case 'code_required':
          return c.json({ ok: true, twoFactorRequired: true, challengeId: outcome.challengeId });
      }
    })

    // 第二步：验证邮箱验证码（挑战 5 分钟有效，错 5 次作废，一次性消费防重放）
    .post('/login/verify', jsonBody(verifySchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIpFromContext(c, config);

      const outcome = await verifyLoginCode(s, config, {
        challengeId: body.challengeId,
        code: body.code,
        ip,
      });

      void recordAudit(s.db, {
        actor: 'user',
        action: `auth.login.verify.${outcome.kind}`,
        targetType: 'user',
        targetId: outcome.kind === 'success' ? outcome.userId : null,
        detail: { ip },
      });

      switch (outcome.kind) {
        case 'code_invalid':
          throw new HttpError('CODE_INVALID');
        case 'challenge_invalid':
          return c.json(
            { error: { message: '验证码已过期、不存在或错误次数过多，请重新登录', code: 'CHALLENGE_INVALID' } },
            400,
          );
        case 'account_unavailable':
          throw new HttpError('ACCOUNT_UNAVAILABLE');
        case 'success': {
          setCookie(
            c,
            SESSION_COOKIE,
            outcome.token,
            cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S),
          );
          return c.json({
            ok: true,
            user: { id: outcome.userId, email: outcome.email, gifted: outcome.gifted },
          });
        }
      }
    })

    // ── 邮箱自助注册（两步：注册 → 邮箱验证码 → 建号并自动登录）──

    // 第一步：邮箱 + 密码 → 发验证码（不建号）
    .post('/register', jsonBody(registerSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIpFromContext(c, config);
      const outcome = await register(s, config, { email: body.email, password: body.password, ip });

      void recordAudit(s.db, {
        actor: 'user',
        action: `auth.register.${outcome.kind}`,
        targetType: 'user',
        targetId: null,
        detail: { email: body.email.slice(0, 64), ip },
      });

      switch (outcome.kind) {
        case 'rate_limited':
          throw new HttpError('REGISTER_RATE_LIMITED', '注册请求过于频繁，请稍后再试', undefined, {
            'retry-after': String(outcome.retryAfterSec),
          });
        case 'email_taken':
          throw new HttpError('EMAIL_TAKEN', '该邮箱已注册，请直接登录');
        case 'mailer_unavailable':
          throw new HttpError(
            'TWO_FACTOR_UNAVAILABLE',
            '注册需邮箱验证码，但服务端未配置 SMTP——请联系管理员（不降级）',
          );
        case 'code_rate_limited':
          throw new HttpError('CODE_RATE_LIMITED', '验证码发送过于频繁，请 1 分钟后再试', undefined, {
            'retry-after': String(outcome.retryAfterSec),
          });
        case 'code_send_failed':
          throw new HttpError('CODE_SEND_FAILED');
        case 'code_required':
          return c.json({ ok: true, challengeId: outcome.challengeId });
      }
    })

    // 第二步：验证注册验证码 → 建号 + 自动登录（并发撞邮箱由唯一索引兜底 → 409）
    .post('/register/verify', jsonBody(verifySchema), async (c) => {
      const body = c.req.valid('json');
      const outcome = await verifyRegistration(s, config, {
        challengeId: body.challengeId,
        code: body.code,
      });

      void recordAudit(s.db, {
        actor: 'user',
        action: `auth.register.verify.${outcome.kind}`,
        targetType: 'user',
        targetId: outcome.kind === 'success' ? outcome.userId : null,
        detail: outcome.kind === 'email_taken' ? { reason: 'concurrent' } : {},
      });

      switch (outcome.kind) {
        case 'code_invalid':
          throw new HttpError('CODE_INVALID');
        case 'challenge_invalid':
          return c.json(
            { error: { message: '验证码已过期、不存在或错误次数过多，请重新注册', code: 'CHALLENGE_INVALID' } },
            400,
          );
        case 'email_taken':
          throw new HttpError('EMAIL_TAKEN', '该邮箱已注册，请直接登录');
        case 'success': {
          setCookie(
            c,
            SESSION_COOKIE,
            outcome.token,
            cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S),
          );
          return c.json({
            ok: true,
            user: { id: outcome.userId, email: outcome.email, gifted: outcome.gifted },
          });
        }
      }
    })

    // 注销
    .post('/logout', (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
}

/** 受保护的认证端点（挂载于 /api/auth） */
export function clientAuthRoutesProtected(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 修改密码（userSessionMiddleware 已注入 session）
    .post('/password', jsonBody(passwordChangeSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');

      const rows = await s.db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      if (rows.length === 0) throw new HttpError('USER_NOT_FOUND', '用户不存在');
      const u = rows[0]!;

      const ok = await verifyPassword(body.oldPassword, u.passwordHash);
      if (!ok) throw new HttpError('INVALID_CREDENTIALS', '原密码错误');

      const newHash = await hashPassword(body.newPassword);
      // R5-2：改密即吊销全部既有会话（iat 早于失效线的旧 token 一律 401）
      await s.db
        .update(users)
        .set({ passwordHash: newHash, sessionInvalidBefore: new Date(), updatedAt: new Date() })
        .where(eq(users.id, u.id));
      await recordAudit(s.db, {
        actor: 'user',
        action: 'user.password_change',
        targetType: 'user',
        targetId: session.userId,
      });
      return c.json({ ok: true });
    });
}
