/**
 * 用户面会话中间件（Bearer）：Authorization: Bearer <会话 JWT> → 装配注入的
 * validateSession（identity.sessions.validate 验签+jti+吊销线 + 账户状态读，静默
 * null）→ 通过则注入会话变量。统一 401 不区分原因（防账号枚举）。
 * 无 Cookie 无 CSRF：控制台类客户端自持 Bearer，凭据不经浏览器自动携带。
 *
 * SessionContext 是本 app 全路由统一上下文（对应旧 Hono SessionEnv）：
 * 协议栈已装 bodyParser——c.req facade 类型随上下文给出。
 */
import { HttpErrors, type ContextOf, type ContextWithBody, type Middleware } from '@tillgate/http';

/** 会话中间件注入的请求级变量（requestId 由协议栈 requestIdMiddleware 先置） */
export interface SessionState {
  requestId: string;
  userId: number;
  /** 当前会话 jti/exp（logout 端点消费） */
  sessionJti: string;
  sessionExp: number;
}

export type SessionContext = ContextOf<SessionState> & ContextWithBody;
export type SessionMiddleware = Middleware<SessionContext>;

export interface SessionInfo {
  userId: number;
  jti: string;
  exp: number;
}

export type SessionValidator = (token: string) => Promise<SessionInfo | null>;

export function sessionMiddleware(validate: SessionValidator): SessionMiddleware {
  return async (c, next) => {
    const header = c.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token === '') {
      throw HttpErrors.business('unauthorized');
    }
    const session = await validate(token);
    if (session === null) {
      throw HttpErrors.business('unauthorized');
    }
    c.state.userId = session.userId;
    c.state.sessionJti = session.jti;
    c.state.sessionExp = session.exp;
    await next();
  };
}
