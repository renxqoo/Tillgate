import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { verifySession, SESSION_COOKIE } from '../lib/session.js';

/**
 * admin-api 鉴权中间件（S4 + §5）。
 *
 * 管理端 /api/admin/* 接口接受两种凭证之一：
 *   A. 机器令牌（脚本/CI）：Authorization: Bearer <ADMIN_API_TOKEN> 或 X-Admin-Token
 *      - fail-closed：ADMIN_API_TOKEN 未配置或为空时该项不可用（机器令牌永远不放行）
 *      - 时序安全：timingSafeEqual 防时序攻击
 *   B. 管理员会话（控制台）：HttpOnly Cookie 中 role=1 的面板 JWT
 *      - 验签后回查 users 表，role=1 且 status=0 才放行
 *
 * 任一通过即放行。两者都无效 → 401。
 */
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 尝试用机器令牌鉴权（S4 API Token）。
 *   - 未配置 token → 机器令牌不可用（返回 false，让位给会话鉴权）
 *   - 配置了但凭证不匹配 → 返回 false（不立即 401，留机会给会话鉴权）
 */
function checkMachineToken(c: Parameters<MiddlewareHandler>[0], adminToken: string | undefined): boolean {
  if (!adminToken || adminToken.length === 0) return false;
  const authHeader = c.req.header('authorization');
  let token: string | null = null;
  if (authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    token = m?.[1] ?? null;
  }
  if (!token) token = c.req.header('x-admin-token') ?? null;
  if (!token) return false;
  return safeEqual(token, adminToken);
}

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
 * 管理端鉴权中间件：机器令牌 OR 管理员会话，任一通过即可。
 *
 *   - db / jwtSecret 缺省时仅走机器令牌路径（向后兼容纯 token 调用）
 *   - 二者均未配置且无会话 → 401
 */
export function adminAuthMiddleware(
  adminToken: string | undefined,
  db?: Db,
  jwtSecret?: string,
): MiddlewareHandler {
  return async (c, next) => {
    // 1. 机器令牌
    if (checkMachineToken(c, adminToken)) {
      await next();
      return;
    }
    // 2. 管理员会话
    if (db && jwtSecret && (await checkAdminSession(c, db, jwtSecret))) {
      await next();
      return;
    }
    // 3. fail-closed：未配置任何可用凭证来源 → 503（防裸奔）
    if ((!adminToken || adminToken.length === 0) && !jwtSecret) {
      return c.json(
        { error: { message: '管理端未配置任何鉴权方式（ADMIN_API_TOKEN/会话），拒绝服务（fail-closed）', code: 'ADMIN_AUTH_NOT_CONFIGURED' } },
        503,
      );
    }
    return c.json({ error: { message: '缺少管理端凭证', code: 'UNAUTHORIZED' } }, 401);
  };
}
