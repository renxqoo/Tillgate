/**
 * 管理面会话中间件（Bearer）：Authorization: Bearer <JWT> → identity admin realm
 * 全链校验（HS256 验签 + issuer/realm 比对 + jti 吊销 + 锚点线）→ 属主回查
 * （admins 行存在且 status=0——封禁/注销的会话即刻失效,P2/D8/W3 兑现）→ 注入会话变量。
 * 失败统一 401 不区分原因（不泄漏管理账号状态）。
 * 无 Cookie 无 CSRF：管理台类客户端自持 Bearer，凭据不经浏览器自动携带。
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { SessionPayload } from '@tokenlens/identity';
import type { ControlContext } from '@tokenlens/control-plane';
import { HttpErrors } from '@tokenlens/http';

/** 会话校验依赖（identity facade + 管理员资料属主回查——结构子集,app 只持闭包） */
export interface SessionValidator {
  validate(token: string, realm: 'admin'): Promise<SessionPayload | null>;
  /** 属主回查：admins 行（不存在/封禁/注销 → null = 401——v1 D8/W3 语义）。
   *  role 随回查投影注入 adminRole（RBAC——角色变更下一请求即生效,不嵌 JWT）。 */
  owner?: (adminId: number) => Promise<{ status: number; role: string } | null>;
}

export interface SessionEnv {
  Variables: {
    requestId: string;
    adminId: number;
    /** 当前管理员 RBAC 角色（属主回查搭载;回查缺省的纯会话校验形态下无此变量 →
     *  权限守卫 fail-closed 403——装配形态决定权限面,不静默放行） */
    adminRole: string;
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
    // 属主回查（装配缺省不回查 = 纯会话校验形态;生产装配必注入——v1 B01 收敛口径）
    if (sessions.owner != null) {
      const owner = await sessions.owner(adminId);
      if (owner == null || owner.status !== 0) {
        throw HttpErrors.business('unauthorized');
      }
      c.set('adminRole', owner.role);
    }
    c.set('adminId', adminId);
    c.set('sessionToken', token);
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
