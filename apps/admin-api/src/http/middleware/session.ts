/**
 * 管理面会话中间件（Bearer）：Authorization: Bearer <JWT> → identity admin realm
 * 全链校验（HS256 验签 + issuer/realm 比对 + jti 吊销 + 锚点线）→ 属主回查
 * （findAccess 一条 join：状态 + isSuper + active 码集合）→ 注入会话变量。
 * 失败统一 401 不区分原因（不泄漏管理账号状态）。
 * 无 Cookie 无 CSRF：管理台类客户端自持 Bearer，凭据不经浏览器自动携带。
 *
 * AdminContext 是本 app 全路由统一上下文（对应旧 Hono SessionEnv）：
 * 协议栈已装 bodyParser——c.req facade 类型随上下文给出。
 */
import type { SessionPayload } from '@tillgate/identity';
import type { AdminAccess, AdminGrants, ControlContext } from '@tillgate/control-plane';
import { HttpErrors, type ContextOf, type ContextWithBody, type Middleware } from '@tillgate/http';

export type { AdminAccess };

/** 会话校验依赖（identity facade + 属主回查——结构子集,app 只持闭包） */
export interface SessionValidator {
  validate(token: string, realm: 'admin'): Promise<SessionPayload | null>;
  /** 属主回查（一条 join）：状态 + isSuper + active 码集合;不存在 → null = 401。
   *  授权面随回查注入——角色/授权变更下一请求即生效（不嵌 JWT）。 */
  owner?: (adminId: number) => Promise<AdminAccess | null>;
}

/** 会话中间件注入的请求级变量（requestId 由协议栈 requestIdMiddleware 先置） */
export interface AdminState {
  requestId: string;
  adminId: number;
  /** 会话授权面（guard 工厂消费;回查缺省形态下无此变量 → 权限守卫 fail-closed） */
  grants: AdminGrants;
  /** 原始 Bearer token（logout 吊销需要原始值——jti 提取在 identity 内完成） */
  sessionToken: string;
  /** 当前会话 jti/exp */
  sessionJti: string;
  sessionExp: number;
}

export type AdminContext = ContextOf<AdminState> & ContextWithBody;

export function sessionMiddleware(sessions: SessionValidator): Middleware<AdminContext> {
  return async (c, next) => {
    const header = c.get('authorization') ?? '';
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
      c.state.grants = access.grants;
    }
    c.state.adminId = adminId;
    c.state.sessionToken = token;
    c.state.sessionJti = session.jti;
    c.state.sessionExp = session.exp;
    await next();
  };
}

/** 路由层调用上下文派生：会话已注入 adminId，此处只是「HTTP 请求 → 用例上下文」
 *  的形状转换——不放业务参数。 */
export function controlContextOf(c: AdminContext): ControlContext {
  return { requestId: c.state.requestId, actor: { kind: 'admin', id: c.state.adminId } };
}
