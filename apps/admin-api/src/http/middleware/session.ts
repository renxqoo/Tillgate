/**
 * 管理面会话中间件（Bearer）：Authorization: Bearer <JWT> → identity admin realm
 * 全链校验（HS256 验签 + issuer/realm 比对 + jti 吊销 + 锚点线）→ 注入会话变量。
 * 失败统一 401 不区分原因（不泄漏管理账号状态）。
 * 属主回查（admins.status）为 identity W3 pending——DESIGN §5 D8。
 * 无 Cookie 无 CSRF：管理台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { SessionPayload } from '@tokenlens/identity';
import type { ControlContext } from '@tokenlens/control-plane';
import { HttpErrors } from '@tokenlens/http';

/** 会话校验依赖（identity facade 结构子集——app 只持闭包与纯契约） */
export interface SessionValidator {
  validate(token: string, realm: 'admin'): Promise<SessionPayload | null>;
}

export interface SessionEnv {
  Variables: {
    requestId: string;
    adminId: number;
    /** 当前会话 jti/exp（P2 登录波 logout 吊销消费） */
    sessionJti: string;
    sessionExp: number;
  };
}

export function sessionMiddleware(sessions: SessionValidator): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token === '') {
      throw HttpErrors.business('unauthorized');
    }
    const session = await sessions.validate(token, 'admin');
    if (session === null) {
      throw HttpErrors.business('unauthorized');
    }
    const adminId = Number(session.sub);
    if (!Number.isInteger(adminId) || adminId < 1) {
      throw HttpErrors.business('unauthorized');
    }
    c.set('adminId', adminId);
    c.set('sessionJti', session.jti);
    c.set('sessionExp', session.exp);
    await next();
  };
}

/** 路由层调用上下文派生：会话已注入 adminId，此处只是「HTTP 请求 → 用例上下文」
 *  的形状转换（v1 routes/ctx.ts adminCtxOf 平移）——不放业务参数。 */
export function controlContextOf(c: Context<SessionEnv>): ControlContext {
  return { requestId: c.get('requestId'), actor: { kind: 'admin', id: c.get('adminId') } };
}
