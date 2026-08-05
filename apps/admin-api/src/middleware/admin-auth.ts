import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { verifySession, SESSION_COOKIE } from '../lib/session.js';

/**
 * admin-api 鉴权中间件（S4 + §5）。
 *
 * 管理端 /api/admin/* 接口仅接受管理员会话鉴权：
 *   - HttpOnly Cookie 中 role=1 的面板 JWT（控制台登录后获得）
 *   - 验签后回查 users 表，role=1 且 status=0 才放行
 *
 * 无有效会话 → 401。JWT_SECRET 未配置 → 503（fail-closed，防裸奔）。
 */

/** 尝试用管理员会话 Cookie 鉴权（§5 面板 JWT）。 */
async function checkAdminSession(
  c: Parameters<MiddlewareHandler>[0],
  db: Db,
  jwtSecret: string,
): Promise<boolean> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return false;
  const result = await verifySession(token, jwtSecret);
  if (!result.ok || !result.payload) return false;
  const userId = Number(result.payload.sub);
  if (!Number.isFinite(userId) || userId <= 0) return false;
  if (result.payload.role !== 1) return false; // 仅管理员
  const row = await db
    .select({ status: users.status, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row.length === 0) return false;
  const u = row[0]!;
  return u.status === 0 && u.role === 1; // 正常状态 + 管理员角色
}

/**
 * 管理端鉴权中间件：仅管理员会话。
 *
 *   - jwtSecret 未配置 → 503（fail-closed，防裸奔）
 *   - 会话无效或缺失 → 401
 */
export function adminAuthMiddleware(
  db: Db,
  jwtSecret: string,
): MiddlewareHandler {
  return async (c, next) => {
    if (await checkAdminSession(c, db, jwtSecret)) {
      await next();
      return;
    }
    return c.json({ error: { message: '缺少管理端凭证', code: 'UNAUTHORIZED' } }, 401);
  };
}
