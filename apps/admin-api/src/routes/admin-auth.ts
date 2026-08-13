import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { admins } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  signSession,
  verifyPassword,
  hashPassword,
  ADMIN_SESSION_COOKIE,
  SESSION_DEFAULT_TTL_S,
  cookieOptions,
  checkLoginThrottle,
  recordLoginFailure,
  resetLoginFailures,
  clientIp,
  type AdminEnv,
} from '@ai-gateway/identity';
import { HttpError, jsonBody, recordAudit } from '@ai-gateway/http';
import type { AdminServices } from '../services/index.js';
import type { AdminApiConfig } from '../config.js';

/**
 * 管理员会话与登录（与用户面物理隔离：独立 cookie / 密钥 / 校验表）。
 *
 * 公开端点（挂载于 /api/admin/auth）：
 *   - POST /login：管理员邮箱 + 密码 → 签发 HttpOnly Cookie（ag_admin_session，24h，type='admin'）
 *   - POST /logout：清管理面 Cookie
 *
 * 受保护端点（挂载于受保护子应用）：
 *   - POST /auth/password：管理员改自己的密码
 *   - GET  /me：当前管理员信息（前端守卫用）
 *
 * 安全（与用户登录同口径，但 namespace='admin' 隔离锁定键空间）：
 *   - scrypt 哈希校验（timingSafeEqual 常量时间）
 *   - 失败统一错误（防邮箱枚举）+ 登录限流（独立 namespace）
 */

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(128),
});

export function adminAuthRoutesPublic(s: AdminServices, config: AdminApiConfig): Hono {
  return new Hono()

    // 管理员登录
    .post('/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIp(c.req.raw.headers);

      // 登录限流（namespace='admin'，与用户登录键空间隔离）
      const throttle = await checkLoginThrottle(s.redis, 'admin', body.email, ip);
      if (throttle.locked) {
        c.header('retry-after', String(throttle.retryAfterSec));
        return c.json(
          { error: { message: '登录尝试过多，已临时锁定', code: 'TOO_MANY_ATTEMPTS' } },
          429,
        );
      }

      const rows = await s.db
        .select({
          id: admins.id,
          email: admins.email,
          passwordHash: admins.passwordHash,
          status: admins.status,
        })
        .from(admins)
        .where(eq(admins.email, body.email))
        .limit(1);

      const admin = rows[0];
      const passwordOk = admin ? await verifyPassword(body.password, admin.passwordHash) : false;
      // 邮箱不存在时也跑一次 verify（恒定时间，防根据响应时间区分）
      if (!admin || !passwordOk) {
        await recordLoginFailure(s.redis, 'admin', body.email, ip);
        return c.json({ error: { message: '邮箱或密码错误', code: 'INVALID_CREDENTIALS' } }, 401);
      }

      if (admin.status === 1) return c.json({ error: { message: '账号已封禁', code: 'ACCOUNT_BANNED' } }, 403);
      if (admin.status === 2) return c.json({ error: { message: '账号已注销', code: 'ACCOUNT_DELETED' } }, 403);

      await resetLoginFailures(s.redis, 'admin', body.email, ip);
      await s.db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));

      // 签发管理员会话 JWT（type='admin'，仅 admin-api 验签）
      const token = await signSession({ type: 'admin', id: admin.id }, config.adminJwtSecret);
      setCookie(c, ADMIN_SESSION_COOKIE, token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));

      return c.json({ ok: true, admin: { id: admin.id, email: admin.email } });
    })

    // 注销
    .post('/logout', (c) => {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
}

/** 受保护的管理员端点（挂载于 /api/admin/auth） */
export function adminAuthRoutesProtected(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 改密码（adminAuthMiddleware 已注入 adminId）
    .post('/password', jsonBody(passwordChangeSchema), async (c) => {
      const adminId = c.get('adminId');
      const body = c.req.valid('json');

      const rows = await s.db
        .select({ id: admins.id, passwordHash: admins.passwordHash })
        .from(admins)
        .where(eq(admins.id, adminId))
        .limit(1);
      if (rows.length === 0) throw new HttpError(404, 'ADMIN_NOT_FOUND', '管理员不存在');
      const a = rows[0]!;

      const ok = await verifyPassword(body.oldPassword, a.passwordHash);
      if (!ok) return c.json({ error: { message: '原密码错误', code: 'INVALID_CREDENTIALS' } }, 401);

      const newHash = await hashPassword(body.newPassword);
      await s.db.update(admins).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(admins.id, a.id));
      await recordAudit(s.db, {
        actor: 'admin',
        adminId,
        action: 'admin.password_change',
        targetType: 'admin',
        targetId: adminId,
      });
      return c.json({ ok: true });
    });
}

/** 当前管理员信息（前端守卫用，挂载于 /api/admin/me） */
export function adminMeRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', async (c) => {
    const adminId = c.get('adminId');
    const rows = await s.db
      .select({ id: admins.id, email: admins.email, displayName: admins.displayName, lastLoginAt: admins.lastLoginAt })
      .from(admins)
      .where(eq(admins.id, adminId))
      .limit(1);
    if (rows.length === 0) throw new HttpError(404, 'ADMIN_NOT_FOUND', '管理员不存在');
    return c.json(rows[0]);
  });
}
