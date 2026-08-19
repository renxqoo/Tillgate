/**
 * 管理面会话中间件（Bearer）：Authorization: Bearer <会话 JWT> → 验签
 * （type='admin'，与用户面 token issuer 物理隔离——跨面 token 互斥）
 * → 回查 admins（封禁/注销即时生效）→ 会话失效线（R5-2：iat 早于
 * sessionInvalidBefore 的 token 一律拒绝——改密即全网下线）。
 *
 * 无 Cookie 无 CSRF：管理台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { MiddlewareHandler } from 'hono';
import type { Db } from '@ai-gateway/db';
import { createRepositories } from '@ai-gateway/repository';
import { verifySession } from '@ai-gateway/identity';

export interface SessionEnv {
  Variables: {
    requestId: string;
    adminId: number;
  };
}

export function sessionMiddleware(db: Db, jwtSecret: string): MiddlewareHandler<SessionEnv> {
  const repos = createRepositories();
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) {
      return c.json({ error: { code: 'unauthorized', message: '缺少管理端凭证' } }, 401);
    }
    let payload;
    try {
      payload = await verifySession(token, jwtSecret, 'admin');
    } catch {
      return c.json({ error: { code: 'unauthorized', message: '会话无效或已过期' } }, 401);
    }
    const adminId = Number(payload.sub);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return c.json({ error: { code: 'unauthorized', message: '会话无效' } }, 401);
    }
    const account = await repos.adminAccount.findById(
      { db, requestId: c.get('requestId'), actor: { kind: 'system' }, traceParent: null },
      adminId,
    );
    // 统一 401：不存在/封禁/注销/失效线——不区分原因（不泄漏管理账号状态）
    if (
      !account ||
      account.status !== 0 ||
      (account.sessionInvalidBefore != null &&
        (payload.iatMs ?? payload.iat * 1000) < account.sessionInvalidBefore.getTime())
    ) {
      return c.json({ error: { code: 'unauthorized', message: '会话无效或已过期' } }, 401);
    }
    c.set('adminId', adminId);
    await next();
  };
}
