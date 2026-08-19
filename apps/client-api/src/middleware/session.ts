/**
 * 用户面会话中间件（Bearer）：Authorization: Bearer <会话 JWT> → 验签（type='user'，
 * 与管理面 token issuer 物理隔离）→ 回查 users（封禁/注销即时生效）→ 会话失效线
 * （R5-2：iat 早于 sessionInvalidBefore 的 token 一律拒绝——改密即全网下线）。
 *
 * 无 Cookie 无 CSRF：控制台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { MiddlewareHandler } from 'hono';
import type { Db } from '@ai-gateway/db';
import { createRepositories } from '@ai-gateway/repository';
import { verifySession, type SessionRevocationStore } from '@ai-gateway/identity';

export interface SessionEnv {
  Variables: {
    requestId: string;
    userId: number;
    /** 当前会话 jti/exp（logout 端点吊销消费） */
    sessionJti: string;
    sessionExp: number;
  };
}

export function sessionMiddleware(
  db: Db,
  jwtSecret: string,
  revocationStore?: SessionRevocationStore,
): MiddlewareHandler<SessionEnv> {
  const repos = createRepositories();
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) {
      return c.json({ error: { code: 'unauthorized', message: '缺少会话凭证' } }, 401);
    }
    let payload;
    try {
      payload = await verifySession(token, jwtSecret, 'user');
    } catch {
      return c.json({ error: { code: 'unauthorized', message: '会话无效或已过期' } }, 401);
    }
    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return c.json({ error: { code: 'unauthorized', message: '会话无效' } }, 401);
    }
    // jti 吊销表（登出/强制下线——fail-open，主防线仍是上方 DB 校验）
    if (revocationStore && (await revocationStore.isRevoked(payload.jti))) {
      return c.json({ error: { code: 'unauthorized', message: '会话已注销' } }, 401);
    }
    const account = await repos.userAccount.findById(
      { db, requestId: c.get('requestId'), actor: { kind: 'system' }, traceParent: null },
      userId,
    );
    // 统一 401：不存在/封禁/注销/失效线——不区分原因（防账号枚举）
    if (
      !account ||
      account.status !== 0 ||
      (account.sessionInvalidBefore != null &&
        (payload.iatMs ?? payload.iat * 1000) < account.sessionInvalidBefore.getTime())
    ) {
      return c.json({ error: { code: 'unauthorized', message: '会话无效或已过期' } }, 401);
    }
    c.set('userId', userId);
    c.set('sessionJti', payload.jti);
    c.set('sessionExp', payload.exp);
    await next();
  };
}
