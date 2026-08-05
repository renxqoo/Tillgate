import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { verifySession, SESSION_COOKIE } from '../lib/session.js';

/**
 * 控制台会话中间件（api-contract §5）。
 *
 *   - 从 HttpOnly Cookie 读取会话 JWT 并验签
 *   - 验签后回查 users 表：status=0 正常 → 注入 c.var.session；非正常 → 401
 *     （回查是因为封禁/注销需要即时生效；status 是 DB 权威字段）
 *   - role 注入会话上下文，路由层据此判定管理员权限
 *
 * /api/admin/* 和用户面板 /api/me /api/keys 等统一使用 Cookie 会话鉴权。
 */

export interface SessionContext {
  userId: number;
  role: number; // 0 普通 / 1 管理员
}

/**
 * admin-api 全局 Context Variables 类型。
 *   - session：用户面板会话（userSessionMiddleware 注入）
 *   - adminId：管理端操作人 ID（adminIdInjector 注入；机器令牌调用时为 undefined）
 * 路由工厂用 `Hono<AdminEnv>` 约束，c.get/c.set 才有正确类型。
 */
export type AdminEnv = {
  Variables: {
    session: SessionContext;
    adminId?: number;
  };
};

/**
 * 解析会话：成功返回 SessionContext，失败返回 null。
 * 内部完成验签 + DB 用户状态回查。
 */
export async function resolveSession(
  c: Parameters<MiddlewareHandler>[0],
  db: Db,
  jwtSecret: string,
): Promise<SessionContext | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const result = verifySession(token, jwtSecret);
  const verified = await result;
  if (!verified.ok || !verified.payload) return null;
  const userId = Number(verified.payload.sub);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  // 回查用户状态（封禁/注销需即时生效）
  const row = await db
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row.length === 0) return null;
  const u = row[0]!;
  // 0 正常放行；1 封禁 / 2 注销 → 拒绝
  if (u.status !== 0) return null;
  return { userId: u.id, role: u.role };
}

/**
 * 用户面板会话中间件：必须有有效会话，否则 401。
 * 注入 c.var.session 供下游路由使用。
 */
export function userSessionMiddleware(db: Db, jwtSecret: string): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const session = await resolveSession(c, db, jwtSecret);
    if (!session) {
      return c.json({ error: { message: '未登录或会话已过期', code: 'UNAUTHORIZED' } }, 401);
    }
    c.set('session', session);
    await next();
  };
}

/**
 * 管理员会话守卫：c.var.session.role 必须为 1，否则 403。
 * 需先经过 userSessionMiddleware。
 */
export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session || session.role !== 1) {
    return c.json({ error: { message: '需要管理员权限', code: 'FORBIDDEN' } }, 403);
  }
  await next();
};
