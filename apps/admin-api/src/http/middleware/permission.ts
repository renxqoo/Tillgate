/**
 * RBAC 权限守卫（docs/admin-rbac/DESIGN.md §2.3）：会话之后、handler 之前，
 * 按「域 × HTTP 方法」判定权限——GET/HEAD → domain:read，其余 → domain:write。
 * 角色判定 = control-plane domain/rbac 纯函数查表（零查询,词表/矩阵单一真相）。
 *
 * 域归属在装配点（app.ts）逐路由组声明：domainGuard(domain, session) 组合后作为
 * 各路由组的会话件传入——26 个路由文件零感知（DESIGN D5）。
 * adminRole 未注入（装配缺省属主回查的纯会话校验形态）→ fail-closed 403。
 */
import type { MiddlewareHandler } from 'hono';
import { can, type PermissionDomain } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from './session';

/** 读动词（GET/HEAD）;其余方法一律视为写——POST/PUT/PATCH/DELETE */
const READ_METHODS = new Set(['GET', 'HEAD']);

/** 单权限守卫：角色无该权限 → 403 insufficient_permission（不泄漏角色事实） */
export function requirePermission(permission: string): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    if (!can(c.get('adminRole') ?? '', permission)) {
      throw AdminErrors.business('insufficient_permission', { permission });
    }
    await next();
  };
}

/**
 * 域守卫组合器：session（会话 + adminRole 注入）→ 按方法分派的权限判定 → 放行。
 * 返回值形态与 session 中间件同签名——路由组挂载点原位替换,路由文件不感知。
 */
export function domainGuard(
  domain: PermissionDomain,
  session: MiddlewareHandler<SessionEnv>,
): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    await session(c, async () => {
      const action = READ_METHODS.has(c.req.method) ? 'read' : 'write';
      await requirePermission(`${domain}:${action}`)(c, next);
    });
  };
}
