import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { users, isAccountUsable } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { sessionValidAt } from '@ai-gateway/identity-core';
import { verifySession } from '../session.js';
import { SESSION_COOKIE } from '../cookies.js';
import type { ClientEnv, UserSessionContext } from '../types.js';

/**
 * 用户面会话中间件（client-api 专用）。
 *
 *   - 读 ag_session Cookie → 验签（type='user'，密钥 JWT_SECRET）→ 回查 users 表 status
 *   - status=0 正常 → 注入 c.var.session（仅 userId，不含 role）
 *   - 封禁(1)/注销(2) → 401（即时生效）
 *
 * 物理隔离：只认用户面 cookie 与密钥，管理员 token（ag_admin_session）在此永远无效。
 *
 * resolveSession：导出给 adminIdInjector 等需要「尽力解析」的场景（失败返回 null 不阻塞）。
 */
export async function resolveUserSession(
  c: Parameters<MiddlewareHandler>[0],
  db: Db,
  jwtSecret: string,
): Promise<UserSessionContext | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  let result;
  try {
    result = await verifySession(token, jwtSecret, 'user');
  } catch {
    // 验签失败（过期/无效）统一 401——可预期拒绝，不是服务端故障
    return null;
  }
  const userId = Number(result.sub);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  // 回查用户状态（封禁/注销需即时生效）
  const row = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row.length === 0) return null;
  // 0 正常放行；1 封禁 / 2 注销 → 拒绝
  if (!isAccountUsable(row[0]!.status)) return null;
  // 会话失效线（R5-2）：改密/重置/换邮箱推进锚点后，签发时间早于锚点的旧 token 一律拒绝
  // R5-2：毫秒精确失效线（iatMs 亚秒声明）；旧 token 无 iatMs 时回退秒级（部署期一次性收紧）
  const issuedMs = result.iatMs ?? result.iat * 1000;
  if (!(await sessionValidAt(db, { userId: row[0]!.id, realm: 'user', iat: issuedMs }))) {
    return null;
  }
  return { userId: row[0]!.id };
}

/**
 * 用户面会话守卫：必须有有效用户会话，否则 401。
 * 挂在 /api/me/*、/api/keys/*、/api/apps/*、/api/usage/*、/api/redeem、/api/auth/password。
 */
export function userSessionMiddleware(db: Db, jwtSecret: string): MiddlewareHandler<ClientEnv> {
  return async (c, next) => {
    const session = await resolveUserSession(c, db, jwtSecret);
    if (!session) {
      return c.json({ error: { message: '未登录或会话已过期', code: 'UNAUTHORIZED' } }, 401);
    }
    c.set('session', session);
    await next();
  };
}
