import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  SESSION_DEFAULT_TTL_S,
  cookieOptions,
  type ClientEnv,
} from '@ai-gateway/identity';
import { clientIpFromContext, csrfProtection, jsonBody, timingSafeTokenEqual } from '@ai-gateway/http';
import type { ClientServices } from '../services/index.js';
import { changeMyPassword, login, verifyLoginCode } from '../services/auth-login.js';
import { register, verifyRegistration } from '../services/auth-register.js';
import type { ClientApiConfig } from '../config.js';

/**
 * 用户面会话与登录（api-contract §4.1 / §5）。
 *
 * 公开端点（挂载于 /api/auth）：
 *   - POST /login：邮箱 + 密码 → 发 6 位邮箱验证码（强制两步，60s 冷却/账号）
 *   - POST /login/verify：验证码通过 → 签发 HttpOnly Cookie 会话 JWT（24h，type='user'）
 *   - POST /logout：清 Cookie
 *   - GET /register/capabilities：注册页能力发现（开关 + Turnstile siteKey）
 *   - POST /register：邮箱 + 密码 →（启用时过人机验证门禁）发验证码（不建号）
 *   - POST /register/verify：验证码通过 → 建号 + 自动登录
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
  /** 人机验证 token（Turnstile，启用 captcha 时必填；服务间豁免调用可不带） */
  captchaToken: z.string().min(1).max(2048).optional(),
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

    // 第一步：邮箱 + 密码 → 发验证码（不签会话）。
    // 失败分支由 service 抛 FlowError（审计随抛一并落库），errorHandler 统一出响应。
    .post('/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIpFromContext(c, config);
      const outcome = await login(s, config, { email: body.email, password: body.password, ip });
      return c.json({ ok: true, twoFactorRequired: true, challengeId: outcome.challengeId });
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
      setCookie(c, SESSION_COOKIE, outcome.token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));
      return c.json({
        ok: true,
        user: { id: outcome.userId, email: outcome.email, gifted: outcome.gifted },
      });
    })

    // ── 邮箱自助注册（两步：注册 → 邮箱验证码 → 建号并自动登录）──

    // 注册页能力发现（单一真相：开关 + 人机验证 siteKey；GET 无 CSRF 面）。
    // 关闭注册时 captchaSiteKey 一并为 null——无注册即无 widget。
    .get('/register/capabilities', (c) =>
      c.json({
        enabled: config.registerEnabled,
        captchaSiteKey: config.registerEnabled ? (s.captcha?.siteKey ?? null) : null,
      }),
    )

    // 第一步：邮箱 + 密码 → 发验证码（不建号）
    .post('/register', jsonBody(registerSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIpFromContext(c, config);
      // 注册开关/审计在 service（auth.register.disabled）；服务间豁免：
      // 恒定时间匹配 x-internal-token（Next.js BFF 转发注册时不携带——
      // token 由浏览器 widget 产生经 body 转发，BFF 若代持内部令牌则机器人调
      // server action 即可绕过人机验证）。
      const captchaExempt =
        !!config.internalApiToken &&
        timingSafeTokenEqual(c.req.header('x-internal-token') ?? '', config.internalApiToken);
      const outcome = await register(s, config, {
        email: body.email,
        password: body.password,
        ip,
        captchaToken: body.captchaToken,
        captchaExempt,
      });
      return c.json({ ok: true, challengeId: outcome.challengeId });
    })

    // 第二步：验证注册验证码 → 建号 + 自动登录（并发撞邮箱由唯一索引兜底 → 409）
    .post('/register/verify', jsonBody(verifySchema), async (c) => {
      const body = c.req.valid('json');
      const outcome = await verifyRegistration(s, config, {
        challengeId: body.challengeId,
        code: body.code,
      });
      setCookie(c, SESSION_COOKIE, outcome.token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));
      return c.json({
        ok: true,
        user: { id: outcome.userId, email: outcome.email, gifted: outcome.gifted },
      });
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

    // 修改密码（校验/换哈希/吊销会话/审计见 service）
    .post('/password', jsonBody(passwordChangeSchema), async (c) => {
      await changeMyPassword(s, c.get('session').userId, c.req.valid('json'));
      return c.json({ ok: true });
    });
}
