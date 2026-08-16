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
  recordLoginFailure,
  resetLoginFailures,
  issueLoginCodeChallenge,
  abortLoginCodeChallenge,
  verifyLoginCodeChallenge,
  LoginCodeCooldownError,
  type AdminEnv,
} from '@ai-gateway/identity';
import { randomInt } from 'node:crypto';
import { clientIpFromContext, csrfProtection, HttpError, jsonBody, recordAudit } from '@ai-gateway/http';
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

export function adminAuthRoutesPublic(s: AdminServices, config: AdminApiConfig): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    // 登录/登出同样过 CSRF 校验（C7 收口）：语义与用户面一致（受信 Origin / 内部令牌兼容规则）。
    .use(csrfProtection({ trustedOrigins: config.trustedOrigins, internalToken: config.internalApiToken }))

    // 管理员登录
    .post('/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const ip = clientIpFromContext(c, config);

      const rows = await s.db
        .select({
          id: admins.id,
          email: admins.email,
          passwordHash: admins.passwordHash,
          status: admins.status,
          twoFactorEnabled: admins.twoFactorEnabled,
        })
        .from(admins)
        .where(eq(admins.email, body.email))
        .limit(1);

      const admin = rows[0];
      // 恒定时间校验（01 修复）：邮箱不存在也跑等量 scrypt，防时序枚举。
      const passwordOk = await verifyPassword(body.password, admin?.passwordHash ?? null);

      // 正确密码豁免（02 修复）：仅密码错误才累计失败并可能触发单源锁定，
      // 正确密码永远放行并清零，防止管理员邮箱被匿名锁死。
      if (!admin || !passwordOk) {
        const throttle = await recordLoginFailure(s.redis, 'admin', body.email, ip);
        if (throttle.locked) {
          void recordAudit(s.db, {
            actor: 'admin',
            adminId: null,
            action: 'auth.login.locked',
            targetType: 'admin',
            targetId: admin?.id ?? null,
            detail: { email: body.email, ip },
          });
          c.header('retry-after', String(throttle.retryAfterSec));
          return c.json(
            { error: { message: '登录尝试过多，已临时锁定', code: 'TOO_MANY_ATTEMPTS' } },
            429,
          );
        }
        void recordAudit(s.db, {
          actor: 'admin',
          adminId: null,
          action: 'auth.login.invalid_credentials',
          targetType: 'admin',
          targetId: admin?.id ?? null,
          detail: { email: body.email, ip },
        });
        throw new HttpError('INVALID_CREDENTIALS');
      }

      if (admin.status === 1) throw new HttpError('ACCOUNT_BANNED');
      if (admin.status === 2) throw new HttpError('ACCOUNT_DELETED');

      await resetLoginFailures(s.redis, 'admin', body.email, ip);
      await s.db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));

      // ── 邮箱验证码二次登录（第八轮）：开启 2FA 的管理员密码正确后先发码，
      //    验证通过（/login/verify）才签发会话。SMTP 未配置 = fail-closed（503），
      //    绝不静默降级为单密码。
      if (admin.twoFactorEnabled) {
        if (!s.mailer) {
          void recordAudit(s.db, {
            actor: 'admin',
            adminId: admin.id,
            action: 'auth.login.2fa_unavailable',
            targetType: 'admin',
            targetId: admin.id,
            detail: { email: body.email, ip },
          });
          return c.json(
            { error: { message: '已开启邮箱验证码登录，但服务端未配置 SMTP——请联系运维（不降级为单密码）', code: 'TWO_FACTOR_UNAVAILABLE' } },
            503,
          );
        }
        // 限发：每管理员 60s 一条（防邮件轰炸）；挑战签发/验证统一走 identity login-code
        const code = String(randomInt(100000, 1000000));
        let challengeId: string;
        try {
          challengeId = await issueLoginCodeChallenge(s.redis, 'admin', String(admin.id), code);
        } catch (e) {
          if (e instanceof LoginCodeCooldownError) {
            return c.json(
              { error: { message: '验证码发送过于频繁，请 1 分钟后再试', code: 'CODE_RATE_LIMITED' } },
              429,
            );
          }
          throw e;
        }
        try {
          await s.mailer.sendLoginCode(admin.email, code, { ip });
        } catch (e) {
          await abortLoginCodeChallenge(s.redis, 'admin', String(admin.id), challengeId);
          void recordAudit(s.db, {
            actor: 'admin',
            adminId: admin.id,
            action: 'auth.login.2fa_send_failed',
            targetType: 'admin',
            targetId: admin.id,
            detail: { email: body.email, err: (e as Error).message.slice(0, 120) },
          });
          return c.json(
            { error: { message: '验证码邮件发送失败，请稍后重试或联系运维', code: 'CODE_SEND_FAILED' } },
            502,
          );
        }
        void recordAudit(s.db, {
          actor: 'admin',
          adminId: admin.id,
          action: 'auth.login.2fa_challenge',
          targetType: 'admin',
          targetId: admin.id,
          detail: { email: body.email, ip },
        });
        return c.json({ ok: true, twoFactorRequired: true, challengeId });
      }

      void recordAudit(s.db, {
        actor: 'admin',
        adminId: admin.id,
        action: 'auth.login.success',
        targetType: 'admin',
        targetId: admin.id,
        detail: { email: body.email, ip },
      });

      // 签发管理员会话 JWT（type='admin'，仅 admin-api 验签）
      const token = await signSession({ type: 'admin', id: admin.id }, config.adminJwtSecret);
      setCookie(c, ADMIN_SESSION_COOKIE, token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));

      return c.json({ ok: true, admin: { id: admin.id, email: admin.email } });
    })

    // 第二步：验证邮箱验证码（challenge 5 分钟有效，错 5 次作废）
    .post(
      '/login/verify',
      csrfProtection({ trustedOrigins: config.trustedOrigins, internalToken: config.internalApiToken }),
      jsonBody(z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })),
      async (c) => {
        const body = c.req.valid('json');
        const ip = clientIpFromContext(c, config);
        const outcome = await verifyLoginCodeChallenge(s.redis, 'admin', body.challengeId, body.code);
        if (!outcome.ok) {
          if (outcome.reason === 'CODE_INVALID') {
            throw new HttpError('CODE_INVALID', '验证码错误');
          }
          throw new HttpError('CHALLENGE_INVALID', '验证码已过期、不存在或错误次数过多，请重新登录');
        }
        const adminId = Number(outcome.subjectId);
        const admin = await s.db.query.admins.findFirst({
          where: eq(admins.id, adminId),
          columns: { id: true, email: true, status: true, sessionInvalidBefore: true },
        });
        if (!admin || admin.status !== 0) {
          throw new HttpError('ACCOUNT_UNAVAILABLE', '账号不可用');
        }
        void recordAudit(s.db, {
          actor: 'admin',
          adminId: admin.id,
          action: 'auth.login.success',
          targetType: 'admin',
          targetId: admin.id,
          detail: { email: admin.email, ip, twoFactor: true },
        });
        const token = await signSession({ type: 'admin', id: admin.id }, config.adminJwtSecret);
        setCookie(c, ADMIN_SESSION_COOKIE, token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));
        return c.json({ ok: true, admin: { id: admin.id, email: admin.email } });
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
      const adminId = c.get('adminId');
      const body = c.req.valid('json');
      if (body.enabled && !s.mailer) {
        throw new HttpError('SMTP_NOT_CONFIGURED', '服务端未配置 SMTP，无法开启邮箱验证码登录');
      }
      const [updated] = await s.db
        .update(admins)
        .set({ twoFactorEnabled: body.enabled, updatedAt: new Date() })
        .where(eq(admins.id, adminId))
        .returning({ id: admins.id, twoFactorEnabled: admins.twoFactorEnabled });
      if (!updated) throw new HttpError('ADMIN_NOT_FOUND', '管理员不存在');
      await recordAudit(s.db, {
        actor: 'admin',
        adminId,
        action: 'auth.two_factor.toggle',
        targetType: 'admin',
        targetId: adminId,
        detail: { enabled: body.enabled },
      });
      return c.json({ ok: true, twoFactorEnabled: updated.twoFactorEnabled });
    })

    // 改密码（adminAuthMiddleware 已注入 adminId）
    .post('/password', jsonBody(passwordChangeSchema), async (c) => {
      const adminId = c.get('adminId');
      const body = c.req.valid('json');

      const rows = await s.db
        .select({ id: admins.id, passwordHash: admins.passwordHash })
        .from(admins)
        .where(eq(admins.id, adminId))
        .limit(1);
      if (rows.length === 0) throw new HttpError('ADMIN_NOT_FOUND', '管理员不存在');
      const a = rows[0]!;

      const ok = await verifyPassword(body.oldPassword, a.passwordHash);
      if (!ok) throw new HttpError('INVALID_CREDENTIALS', '原密码错误');

      const newHash = await hashPassword(body.newPassword);
      // R5-2：管理面改密即吊销全部既有管理会话
      await s.db
        .update(admins)
        .set({ passwordHash: newHash, sessionInvalidBefore: new Date(), updatedAt: new Date() })
        .where(eq(admins.id, a.id));
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
      .select({ id: admins.id, email: admins.email, displayName: admins.displayName, lastLoginAt: admins.lastLoginAt, twoFactorEnabled: admins.twoFactorEnabled })
      .from(admins)
      .where(eq(admins.id, adminId))
      .limit(1);
    if (rows.length === 0) throw new HttpError('ADMIN_NOT_FOUND', '管理员不存在');
    return c.json(rows[0]);
  });
}
