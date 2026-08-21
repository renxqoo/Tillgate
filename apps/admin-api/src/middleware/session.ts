/**
 * 管理面会话中间件（Bearer）：Authorization: Bearer <会话 JWT> → 验签
 * （type='admin'，与用户面 token issuer 物理隔离——跨面 token 互斥）
 * → 回查 admins（封禁/注销即时生效）→ 会话失效线（iat 早于
 * sessionInvalidBefore 的 token 一律拒绝——改密即全网下线）。
 *
 * 无 Cookie 无 CSRF：管理台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { MiddlewareHandler } from 'hono';
import type { Db } from '@ai-gateway/db';
import { createRepositories } from '@ai-gateway/repository';
import { verifySession, type SessionRevocationStore } from '@ai-gateway/identity';
import { localizeMessage, parseAcceptLanguage } from '@ai-gateway/http';

export interface SessionEnv {
  Variables: {
    requestId: string;
    adminId: number;
    /** 当前会话 jti/exp（logout 吊销消费） */
    sessionJti: string;
    sessionExp: number;
  };
}

// 401 统一口径：不区分原因（防账号枚举），文案按协商语言出（默认英文）
const unauthorized = (c: Parameters<MiddlewareHandler<SessionEnv>>[0]) =>
  c.json(
    {
      error: {
        code: 'unauthorized',
        message: localizeMessage('unauthorized', parseAcceptLanguage(c.req.header('accept-language')), 'Session invalid or expired'),
      },
    },
    401,
  );

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
      return unauthorized(c);
    }
    let payload;
    try {
      payload = await verifySession(token, jwtSecret, 'admin');
    } catch {
      return unauthorized(c);
    }
    const adminId = Number(payload.sub);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return unauthorized(c);
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
      return unauthorized(c);
    }
    // jti 吊销表（登出/强制下线——fail-open，主防线是上方 DB 校验）
    if (revocationStore && (await revocationStore.isRevoked(payload.jti))) {
      return unauthorized(c);
    }

    c.set('adminId', adminId);
    c.set('sessionJti', payload.jti);
    c.set('sessionExp', payload.exp);
    await next();
  };
}
