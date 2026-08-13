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
  clientIp,
  type ClientEnv,
} from '@ai-gateway/identity';
import { HttpError, jsonBody, recordAudit } from '@ai-gateway/http';
import type { ClientServices } from '../services/index.js';
import { login } from '../services/auth.js';
import type { ClientApiConfig } from '../config.js';

/**
 * 用户面会话与登录（api-contract §4.1 / §5）。
 *
 * 公开端点（挂载于 /api/auth）：
 *   - POST /login：本地账号（用户名 + 密码）→ 签发 HttpOnly Cookie 会话 JWT（24h，type='user'）
 *   - POST /logout：清 Cookie
 *
 * 受保护端点（挂载于受保护子应用 /auth）：
 *   - POST /password：修改自己的密码（已登录用户）
 */

const loginSchema = z.object({
  /** 本地账号：subject（用户名）；issuer 固定 'local' */
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(256),
});

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(128),
});

export function clientAuthRoutesPublic(s: ClientServices, config: ClientApiConfig): Hono {
  return new Hono()

    // 登录
    .post('/login', jsonBody(loginSchema), async (c) => {
      const body = c.req.valid('json');
      const outcome = await login(s, config, {
        username: body.username,
        password: body.password,
        ip: clientIp(c.req.raw.headers),
      });

      switch (outcome.kind) {
        case 'locked':
          c.header('retry-after', String(outcome.retryAfterSec));
          return c.json(
            { error: { message: '登录尝试过多，已临时锁定', code: 'TOO_MANY_ATTEMPTS' } },
            429,
          );
        case 'invalid_credentials':
          return c.json({ error: { message: '用户名或密码错误', code: 'INVALID_CREDENTIALS' } }, 401);
        case 'banned':
          return c.json({ error: { message: '账号已封禁', code: 'ACCOUNT_BANNED' } }, 403);
        case 'deleted':
          return c.json({ error: { message: '账号已注销', code: 'ACCOUNT_DELETED' } }, 403);
        case 'success': {
          setCookie(c, SESSION_COOKIE, outcome.token, cookieOptions(config.secureCookie, SESSION_DEFAULT_TTL_S));
          return c.json({
            ok: true,
            user: {
              id: outcome.userId,
              username: outcome.username,
              gifted: outcome.gifted,
            },
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
      if (rows.length === 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
      const u = rows[0]!;

      const ok = await verifyPassword(body.oldPassword, u.passwordHash);
      if (!ok) return c.json({ error: { message: '原密码错误', code: 'INVALID_CREDENTIALS' } }, 401);

      const newHash = await hashPassword(body.newPassword);
      await s.db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, u.id));
      await recordAudit(s.db, {
        actor: 'user',
        action: 'user.password_change',
        targetType: 'user',
        targetId: session.userId,
      });
      return c.json({ ok: true });
    });
}
