import type { MiddlewareHandler } from 'hono';
import { GatewayError } from '../lib/errors.js';
import type { KnownErrorCode } from '@ai-gateway/http';
import type { AuthService, AuthContext } from '../services/auth/auth-service.js';
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
export function authMiddleware(authService: AuthService, trustedProxyHops = 0): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const result = await authService.authenticate(c.req.header('authorization'), sourceIp(c, trustedProxyHops));
    if (!result.ok) {
      // AuthResult 拒绝码均已登记注册表 → 统一抛 GatewayError（app.onError 收口渲染）
      throw new GatewayError(result.code as KnownErrorCode, {
        message: result.message,
        ...(result.suggestion !== undefined ? { suggestion: result.suggestion } : {}),
        ...(result.retryAfterSec !== undefined ? { retryAfterSec: result.retryAfterSec } : {}),
      });
    }
    c.set('auth', result.auth);
    await next();
  };
}
