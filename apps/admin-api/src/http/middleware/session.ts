/**
 * 管理面会话中间件（Bearer）：Authorization: Bearer <JWT> → identity admin realm
 * 全链校验（HS256 验签 + issuer/realm 比对 + jti 吊销 + 锚点线）→ 属主回查
 * （findAccess 一条 join：状态 + isSuper + active 码集合）→ 注入会话变量。
 * 失败统一 401 不区分原因（不泄漏管理账号状态）。
 * 无 Cookie 无 CSRF：管理台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { SessionPayload } from '@tillgate/identity';
import type { AdminAccess, AdminGrants, ControlContext } from '@tillgate/control-plane';
import { HttpErrors } from '@tillgate/http';

export type { AdminAccess };

/** 会话校验依赖（identity facade + 属主回查——结构子集,app 只持闭包） */
export interface SessionValidator {
  validate(token: string, realm: 'admin'): Promise<SessionPayload | null>;
  /** 属主回查（一条 join）：状态 + isSuper + active 码集合;不存在 → null = 401。
   *  授权面随回查注入——角色/授权变更下一请求即生效（不嵌 JWT）。 */
  owner?: (adminId: number) => Promise<AdminAccess | null>;
}

export interface SessionEnv {
  Variables: {
    requestId: string;
    adminId: number;
    /** 会话授权面（guard 工厂消费;回查缺省形态下无此变量 → 权限守卫 fail-closed） */
    grants: AdminGrants;
    /** 原始 Bearer token（logout 吊销需要原始值——jti 提取在 identity 内完成） */
    sessionToken: string;
    /** 当前会话 jti/exp */
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
    // 属主回查（装配缺省不回查 = 纯会话校验形态;生产装配必注入）
    if (sessions.owner != null) {
      const access = await sessions.owner(adminId);
      if (access == null || access.status !== 0) {
        throw HttpErrors.business('unauthorized');
      }
      c.set('grants', access.grants);
    }
    c.set('adminId', adminId);
    c.set('sessionToken', token);
    c.set('sessionJti', session.jti);
    c.set('sessionExp', session.exp);
    await next();
  };
}

/** 路由层调用上下文派生：会话已注入 adminId，此处只是「HTTP 请求 → 用例上下文」
 *  的形状转换——不放业务参数。 */
export function controlContextOf(c: Context<SessionEnv>): ControlContext {
  return { requestId: c.get('requestId'), actor: { kind: 'admin', id: c.get('adminId') } };
}
