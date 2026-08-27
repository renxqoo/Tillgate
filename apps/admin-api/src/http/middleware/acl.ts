/**
 * 全局 ACL 中间件。
 *
 * 流程（挂在全部路由之前,与协议栈之后）：
 *   1. 公开白名单（探针/登录族——结构性端点,代码侧声明）→ 直接放行,不做会话；
 *   2. 其余端点先过会话（验签 + 属主回查注入授权面;401 短路）；
 *   3. 自身白名单（/v1/me 族 + logout）→ 有会话即放行,不做码判定；
 *   4. ACL 匹配:绑定表(method+path 模式,Hono ':param' 语法)查该端点挂的权限码
 *      ——未绑定 → fail-closed 403 endpoint_unbound（超管例外:isSuper 短路）;
 *      已绑定 → granted(grants, code) 判定,无权 403 insufficient_permission。
 *
 * 每请求一次绑定表查询（~百行小表,管理面 QPS 下无感;缓存挂账）。
 */

import type { MiddlewareHandler } from 'hono';
import { granted } from '@tillgate/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv, SessionValidator } from './session';
import { sessionMiddleware } from './session';

export interface EndpointBinding {
  readonly method: string;
  readonly path: string;
  readonly code: string;
}

/** 绑定解析器（装配绑定 store 直查;测试可注入替身） */
export type BindingResolver = (method: string, path: string) => Promise<EndpointBinding | null>;

/** 公开白名单:探针 + 登录族（无会话直通——结构性端点,不属运营配置） */
export const PUBLIC_ROUTES: readonly { method: string; path: string }[] = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/livez' },
  { method: 'GET', path: '/readyz' },
  { method: 'POST', path: '/v1/auth/login' },
  { method: 'POST', path: '/v1/auth/login/totp' },
  { method: 'POST', path: '/v1/auth/login/verify' },
];

/** 自身白名单:有会话即放行（不做码判定）——me 族 + logout */
export const SELF_PREFIXES: readonly string[] = ['/v1/me', '/v1/auth/logout'];

function matchesPath(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  // Hono ':param' 段 → 任意非空段
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return false;
  for (const [i, part] of patternParts.entries()) {
    if (part.startsWith(':')) {
      if (pathParts[i] === '') return false;
    } else if (part !== pathParts[i]) {
      return false;
    }
  }
  return true;
}

/** 'method+path' 匹配绑定表(JS 内匹配——绑定表 ~百行,不进 SQL) */
export function matchBinding(
  bindings: readonly EndpointBinding[],
  method: string,
  path: string,
): EndpointBinding | null {
  for (const binding of bindings) {
    if (binding.method === method && matchesPath(binding.path, path)) return binding;
  }
  return null;
}

export function createAclMiddleware(
  sessions: SessionValidator,
  resolve: BindingResolver,
): MiddlewareHandler<SessionEnv> {
  const session = sessionMiddleware(sessions);
  return async (c, next) => {
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
    const { path } = c.req;

    // 只守护 /v1/* 管理面:非 v1 未知路径放行走 404（不泄漏路由清单——v1 语义保留）
    if (!path.startsWith('/v1/')) {
      await next();
      return;
    }
    if (PUBLIC_ROUTES.some((route) => route.method === method && route.path === path)) {
      await next();
      return;
    }

    await session(c, async () => {
      if (SELF_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        await next();
        return;
      }
      const grants = c.get('grants');
      // 超管短路（含未绑定端点——超管始终可进后台补配绑定,这是兜底恢复路径）
      if (grants?.isSuper) {
        await next();
        return;
      }
      const binding = await resolve(method, path);
      if (binding == null) {
        throw AdminErrors.business('endpoint_unbound', { method, path });
      }
      if (!granted(grants ?? { isSuper: false, codes: [] }, binding.code)) {
        throw AdminErrors.business('insufficient_permission', { permission: binding.code });
      }
      await next();
    });
  };
}
