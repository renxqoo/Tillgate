import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { admins, isAccountUsable } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { verifySession } from '../session.js';
import { ADMIN_SESSION_COOKIE } from '../cookies.js';
import type { AdminEnv, AdminSessionContext } from '../types.js';

/**
 * 管理面鉴权中间件（admin-api 专用）。
 *
 *   - 读 ag_admin_session Cookie → 验签（type='admin'，密钥 ADMIN_JWT_SECRET）→ 回查 admins 表 status
 *   - status=0 正常 → 注入 c.var.adminId（对应 admins.id）
 *   - 封禁(1)/注销(2) 或无有效会话 → 401
 *
 * 物理隔离：只认管理面 cookie 与密钥，用户 token（ag_session）在此永远无效。
 *          这是「用户面 bug 无法波及管理员」的执行点。
 *
 * 失败语义：
 *   - ADMIN_JWT_SECRET 未配置（空串）→ 503（fail-closed，防裸奔）
 *   - 会话无效/缺失 → 401
 */
async function resolveAdminSession(
  c: Parameters<MiddlewareHandler>[0],
  db: Db,
  jwtSecret: string,
): Promise<AdminSessionContext | null> {
  const token = getCookie(c, ADMIN_SESSION_COOKIE);
  if (!token) return null;
  let result;
  try {
    result = await verifySession(token, jwtSecret, 'admin');
  } catch {
    // 验签失败（过期/无效）统一 401——可预期拒绝，不是服务端故障
    return null;
  }
  const adminId = Number(result.sub);
  if (!Number.isFinite(adminId) || adminId <= 0) return null;
  // 回查管理员状态（封禁/注销需即时生效）
  const row = await db
    .select({ id: admins.id, status: admins.status, sessionInvalidBefore: admins.sessionInvalidBefore })
    .from(admins)
    .where(eq(admins.id, adminId))
    .limit(1);
  if (row.length === 0) return null;
  if (!isAccountUsable(row[0]!.status)) return null;
  // 会话失效线（R5-2）：管理面改密后旧 token 一律拒绝
  // R5-2：毫秒精确失效线（iatMs 亚秒声明）；旧 token 无 iatMs 时回退秒级（部署期一次性收紧）
  const issuedMs = result.iatMs ?? result.iat * 1000;
  if (row[0]!.sessionInvalidBefore && issuedMs < row[0]!.sessionInvalidBefore.getTime()) {
    return null;
  }
  return { adminId: row[0]!.id };
}

/**
 * 管理面鉴权守卫：仅管理员会话。
 *
 *   - jwtSecret 空串 → 503（fail-closed，防裸奔）
 *   - 会话无效/缺失 → 401
 *   - 放行后注入 c.var.adminId（必填语义，下游路由无需再做防御性检查）
 *
 * 挂载在受保护子应用（/api/admin/* 除显式公开端点外）。
 */
export function adminAuthMiddleware(
  db: Db,
  jwtSecret: string,
): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (!jwtSecret) {
      return c.json({ error: { message: '管理端密钥未配置', code: 'SERVICE_UNAVAILABLE' } }, 503);
    }
    const session = await resolveAdminSession(c, db, jwtSecret);
    if (!session) {
      return c.json({ error: { message: '缺少管理端凭证', code: 'UNAUTHORIZED' } }, 401);
    }
    c.set('adminId', session.adminId);
    await next();
  };
}
