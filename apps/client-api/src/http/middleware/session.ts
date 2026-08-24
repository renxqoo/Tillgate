/**
 * 用户面会话中间件（Bearer）：Authorization: Bearer <会话 JWT> → 装配注入的
 * validateSession（identity.sessions.validate 验签+jti+吊销线 + 账户状态读，静默
 * null）→ 通过则注入会话变量。统一 401 不区分原因（防账号枚举，v1 口径）。
 * 无 Cookie 无 CSRF：控制台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { MiddlewareHandler } from 'hono';
import { HttpErrors } from '@tillgate/http';

export interface SessionEnv {
  Variables: {
    requestId: string;
    userId: number;
    /** 当前会话 jti/exp（logout 端点消费） */
    sessionJti: string;
    sessionExp: number;
  };
}

export interface SessionInfo {
  userId: number;
  jti: string;
  exp: number;
}

export type SessionValidator = (token: string) => Promise<SessionInfo | null>;

export function sessionMiddleware(validate: SessionValidator): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token === '') {
      throw HttpErrors.business('unauthorized');
    }
    const session = await validate(token);
    if (session === null) {
      throw HttpErrors.business('unauthorized');
    }
    c.set('userId', session.userId);
    c.set('sessionJti', session.jti);
    c.set('sessionExp', session.exp);
    await next();
  };
}
