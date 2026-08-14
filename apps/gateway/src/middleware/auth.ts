import type { MiddlewareHandler } from 'hono';
import { errorResponse } from '../lib/http.js';
import { AuthService, type AuthContext } from '../services/auth/auth-service.js';
import { sourceIp } from './auth-failure-guard.js';

/** 鉴权上下文（鉴权通过后挂在 c.var.auth，后续路由/计量使用） */
export type { AuthContext };

export interface AuthEnv {
  Variables: {
    auth: AuthContext;
    requestId: string;
  };
}

/**
 * 鉴权中间件（requirements 4.2）：
 *   - ag_ 前缀 → 静态 Key（SHA-256 查 api_keys + 爆破防护 + Redis 快照缓存）
 *   - 非 ag_ → JWT（jose 验签 + jti 黑名单 + App 状态缓存）
 * 鉴权逻辑集中在 AuthService，中间件只做「失败转错误信封 / 成功挂上下文」。
 */
export function authMiddleware(authService: AuthService): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const result = await authService.authenticate(c.req.header('authorization'), sourceIp(c));
    if (!result.ok) {
      if (result.retryAfterSec !== undefined) {
        c.header('retry-after', String(result.retryAfterSec));
      }
      return errorResponse(c, result.status, result.code, result.message, result.suggestion);
    }
    c.set('auth', result.auth);
    await next();
  };
}
