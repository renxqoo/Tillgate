/**
 * 动态 RBAC 权限守卫（ADR-0008;docs/admin-rbac-dynamic/DESIGN §3——方案 B 逐端点声明）：
 *
 *   const guard = guardFactory(session);
 *   app.post('/v1/admins', guard('admins:create'), handler);
 *
 * - 码在构建期经 enforced 注册表校验（未知码拒构建——fail-closed,不静默放行）;
 * - 判定原语 granted(grants, code)：isSuper 短路全量 / 会话码集合包含;
 * - 会话(含授权面注入) → 码判定 → handler;401 优先于 403;
 * - 会话上下文无授权面（装配缺省属主回查形态）→ fail-closed 403。
 * 旧 domainGuard（方法分派）已随 静态矩阵退役。
 */
import type { MiddlewareHandler } from 'hono';
import { granted, isEnforcedCode, type AdminGrants } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from './session';

/** 路由文件依赖签名：只发 guard 工厂——忘挂码 = 编译错误（完备性的类型面） */
export type GuardFactory = (code: string) => MiddlewareHandler<SessionEnv>;

export function guardFactory(session: MiddlewareHandler<SessionEnv>): GuardFactory {
  return (code: string) => {
    if (!isEnforcedCode(code)) {
      // 构建期即炸:码不在注册表 = 路由声明笔误,不许带病上线
      throw new Error(`[rbac] unknown permission code on route: ${code}`);
    }
    return async (c, next) => {
      await session(c, async () => {
        const grants = c.get('grants');
        if (grants == null || !granted(grants as AdminGrants, code)) {
          throw AdminErrors.business('insufficient_permission', { permission: code });
        }
        await next();
      });
    };
  };
}

/** 单码判定（已过会话的上下文内使用;guard 工厂之外的自定义场景） */
export function requireCode(code: string): MiddlewareHandler<SessionEnv> {
  if (!isEnforcedCode(code)) {
    throw new Error(`[rbac] unknown permission code: ${code}`);
  }
  return async (c, next) => {
    const grants = c.get('grants');
    if (grants == null || !granted(grants as AdminGrants, code)) {
      throw AdminErrors.business('insufficient_permission', { permission: code });
    }
    await next();
  };
}
