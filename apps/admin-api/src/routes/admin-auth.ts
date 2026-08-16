import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  ADMIN_SESSION_COOKIE,
  SESSION_DEFAULT_TTL_S,
  cookieOptions,
  type AdminEnv,
} from '@ai-gateway/identity';
import { clientIpFromContext, csrfProtection, jsonBody } from '@ai-gateway/http';
import type { AdminServices } from '../services/index.js';
import type { AdminApiConfig } from '../config.js';
import { adminLogin, changeAdminPassword, getAdminMe, setTwoFactorEnabled, verifyAdminLoginCode } from '../services/auth.js';

/**
 * 管理员会话与登录（与用户面物理隔离：独立 cookie / 密钥 / 校验表）。
 *
 * 公开端点（挂载于 /api/admin/auth）：
 *   - POST /login：邮箱 + 密码 → 未开 2FA 直接签发 ag_admin_session；已开 2FA 发码
 *   - POST /login/verify：2FA 第二步，验码通过签发会话
 *   - POST /logout：清管理面 Cookie
 *
 * 受保护端点（挂载于受保护子应用）：
 *   - POST /auth/two-factor：邮箱验证码二次登录开关
 *   - POST /auth/password：管理员改自己的密码
 *   - GET  /me：当前管理员信息（前端守卫用）
 *
 * 业务与错误语义在 services/auth.ts（失败抛 FlowError，审计随判定落库）；
 * 本文件只做入参解析、CSRF、会话 Cookie 与成功响应塑形。
 */

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(128),
});

export function adminAuthRoutesPublic(s: AdminServices, config: AdminApiConfig): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    // 登录/登出同样过 CSRF 校验（C7 收口）：语义与用户面一致（受信 Origin / 内部令牌兼容规则）。
    .use(csrfProtection({ trustedOrigins: config.trustedOrigins, internalToken: config.internalApiToken }))

    // 管理员登录（失败分支由 service 抛 FlowError，errorHandler 统一出响应）
    .post('/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const outcome = await adminLogin(s, config, {
        email: body.email,
        password: body.password,
        ip: clientIpFromContext(c, config),
      });
      if (outcome.kind === 'code_required') {
        return c.json({ ok: true, twoFactorRequired: true, challengeId: outcome.challengeId });
      }
      setCookie(c, ADMIN_SESSION_COOKIE, outcome.token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));
      return c.json({ ok: true, admin: { id: outcome.adminId, email: outcome.email } });
    })

    // 第二步：验证邮箱验证码（挑战 5 分钟有效，错 5 次作废）
    .post(
      '/login/verify',
      csrfProtection({ trustedOrigins: config.trustedOrigins, internalToken: config.internalApiToken }),
      jsonBody(z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })),
      async (c) => {
        const body = c.req.valid('json');
        const admin = await verifyAdminLoginCode(s, config, {
          challengeId: body.challengeId,
          code: body.code,
          ip: clientIpFromContext(c, config),
        });
        setCookie(c, ADMIN_SESSION_COOKIE, admin.token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));
        return c.json({ ok: true, admin: { id: admin.adminId, email: admin.email } });
      },
    )

    // 注销
    .post('/logout', (c) => {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
}

/** 受保护的管理员端点（挂载于 /api/admin/auth） */
export function adminAuthRoutesProtected(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 邮箱验证码二次登录开关（自助；开启要求 SMTP 已配置——fail-closed）
    .post('/two-factor', jsonBody(z.object({ enabled: z.boolean() })), async (c) => {
      const body = c.req.valid('json');
      const twoFactorEnabled = await setTwoFactorEnabled(s, c.get('adminId'), body.enabled);
      return c.json({ ok: true, twoFactorEnabled });
    })

    // 改密码（adminAuthMiddleware 已注入 adminId；改密即吊销全部既有管理会话）
    .post('/password', jsonBody(passwordChangeSchema), async (c) => {
      const body = c.req.valid('json');
      await changeAdminPassword(s, c.get('adminId'), {
        oldPassword: body.oldPassword,
        newPassword: body.newPassword,
      });
      return c.json({ ok: true });
    });
}

/** 当前管理员信息（前端守卫用，挂载于 /api/admin/me） */
export function adminMeRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', async (c) => c.json(await getAdminMe(s, c.get('adminId'))));
}
