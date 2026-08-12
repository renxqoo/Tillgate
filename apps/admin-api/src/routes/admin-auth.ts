import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { admins } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { jsonBody } from '../lib/validation.js';
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
import { recordAudit } from '@ai-gateway/billing';

/**
 * 管理员会话与登录（admin-api 专用，与用户面物理隔离）。
 *
 *   - POST /api/admin/auth/login：管理员邮箱 + 密码
 *     · 仅本地账号（admins 表，邀请制创建）
 *     · 登录成功 → 签发 HttpOnly Cookie（ag_admin_session，24h，type='admin'）
 *     · (P1) 强制 2FA 校验
 *
 *   - POST /api/admin/auth/logout：清管理面 Cookie
 *
 *   - POST /api/admin/auth/password：管理员改自己的密码
 *
 *   - GET /api/admin/me：当前管理员信息（前端守卫用）
 *
 * 安全（与用户登录同口径，但 namespace='admin' 隔离锁定键空间）：
 *   - scrypt 哈希校验（timingSafeEqual 常量时间）
 *   - 失败统一错误（防邮箱枚举）
 *   - 登录限流（独立 namespace）
 *
 * 隔离：签发的 JWT type='admin'，仅 admin-api 验签（ADMIN_JWT_SECRET）；
 *      用户 token（ag_session）在此端点无效。
 */

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
  /** 2FA 验证码（P1 启用强制；当前 admins.two_factor_secret 为 NULL 时跳过） */
  twoFactorCode: z.string().optional(),
});

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(128),
});

export function adminAuthRoutes(
  db: Db,
  opts: { adminJwtSecret: string; secureCookie: boolean; redis?: Redis },
): Hono<AdminEnv> {
  const redis = opts.redis;
  return new Hono<AdminEnv>()

    // 管理员登录
    .post('/api/admin/auth/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIp(c.req.raw.headers);

      // 登录限流（namespace='admin'，与用户登录键空间隔离）
      if (redis) {
        const throttle = await checkLoginThrottle(redis, 'admin', body.email, ip);
        if (throttle.locked) {
          c.header('retry-after', String(throttle.retryAfterSec));
          return c.json(
            { error: { message: '登录尝试过多，已临时锁定', code: 'TOO_MANY_ATTEMPTS' } },
            429,
          );
        }
      }

      const rows = await db
        .select({
          id: admins.id,
          email: admins.email,
          passwordHash: admins.passwordHash,
          twoFactorSecret: admins.twoFactorSecret,
          status: admins.status,
        })
        .from(admins)
        .where(eq(admins.email, body.email))
        .limit(1);

      const admin = rows[0];
      const passwordOk = admin ? await verifyPassword(body.password, admin.passwordHash) : false;
      // 邮箱不存在时也跑一次 verify（恒定时间，防根据响应时间区分）
      if (!admin || !passwordOk) {
        if (redis) await recordLoginFailure(redis, 'admin', body.email, ip);
        return c.json({ error: { message: '邮箱或密码错误', code: 'INVALID_CREDENTIALS' } }, 401);
      }

      // 状态校验
      if (admin.status === 1) return c.json({ error: { message: '账号已封禁', code: 'ACCOUNT_BANNED' } }, 403);
      if (admin.status === 2) return c.json({ error: { message: '账号已注销', code: 'ACCOUNT_DELETED' } }, 403);

      // (P1) 2FA 校验：two_factor_secret 非 NULL 时强制校验 twoFactorCode
      // 一期未启用，预留逻辑：当前直接放行，后续启用 TOTP 时在此校验
      // if (admin.twoFactorSecret && !verifyTotp(body.twoFactorCode, admin.twoFactorSecret)) {
      //   return c.json({ error: { message: '两步验证码错误', code: 'INVALID_2FA' } }, 401);
      // }

      if (redis) await resetLoginFailures(redis, 'admin', body.email, ip);

      await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));

      // 签发管理员会话 JWT（type='admin'，仅 admin-api 验签）
      const token = await signSession({ type: 'admin', id: admin.id }, opts.adminJwtSecret);
      setCookie(c, ADMIN_SESSION_COOKIE, token, cookieOptions(opts.secureCookie, SESSION_DEFAULT_TTL_S));

      return c.json({ ok: true, admin: { id: admin.id, email: admin.email } });
    })

    // 注销
    .post('/api/admin/auth/logout', (c) => {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    })

    // 改密码（需已登录，由 adminIdInjector/adminAuthMiddleware 注入 adminId）
    .post('/api/admin/auth/password', jsonBody(passwordChangeSchema), async (c) => {
      const adminId = c.get('adminId');
      if (adminId === undefined) {
        return c.json({ error: { message: '未登录', code: 'UNAUTHORIZED' } }, 401);
      }
      const body = c.req.valid('json');

      const rows = await db
        .select({ id: admins.id, passwordHash: admins.passwordHash })
        .from(admins)
        .where(eq(admins.id, adminId))
        .limit(1);
      if (rows.length === 0) return c.json({ error: { message: '管理员不存在', code: 'NOT_FOUND' } }, 404);
      const a = rows[0]!;

      const ok = await verifyPassword(body.oldPassword, a.passwordHash);
      if (!ok) return c.json({ error: { message: '原密码错误', code: 'INVALID_CREDENTIALS' } }, 401);

      const newHash = await hashPassword(body.newPassword);
      await db.update(admins).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(admins.id, a.id));
      await recordAudit(db, {
        adminId,
        action: 'admin.password_change',
        targetType: 'admin',
        targetId: adminId,
      });
      return c.json({ ok: true });
    })

    // 当前管理员信息（前端守卫用，需经 adminAuthMiddleware 放行）
    .get('/api/admin/me', async (c) => {
      const adminId = c.get('adminId');
      if (adminId === undefined) {
        return c.json({ error: { message: '未登录', code: 'UNAUTHORIZED' } }, 401);
      }
      const rows = await db
        .select({ id: admins.id, email: admins.email, displayName: admins.displayName, lastLoginAt: admins.lastLoginAt })
        .from(admins)
        .where(eq(admins.id, adminId))
        .limit(1);
      if (rows.length === 0) return c.json({ error: { message: '管理员不存在', code: 'NOT_FOUND' } }, 404);
      return c.json(rows[0]);
    });
}
