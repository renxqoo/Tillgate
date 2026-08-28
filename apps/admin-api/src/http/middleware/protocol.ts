/**
 * 协议中间件三件套 消费 @tillgate/http：
 * CORS 预检（白名单空 = 不放行跨域）/ 安全响应头 / 请求体上限 / 服务端 requestId。
 */
import type { MiddlewareHandler } from 'hono';
import {
  bodyParserLimit,
  corsPreflight,
  requestIdMiddleware,
  securityHeaders,
} from '@tillgate/http';
import type { SessionEnv } from './session';

export interface ProtocolConfig {
  readonly corsOrigins: readonly string[];
  readonly bodyLimitBytes: number;
}

/** 管理面预检参数（方法/头集合 = 管理台客户端实际使用面） */
const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const CORS_ALLOW_HEADERS = ['Authorization', 'Content-Type', 'Idempotency-Key'] as const;
const CORS_MAX_AGE_SECONDS = 600;

export function protocolStack(config: ProtocolConfig): MiddlewareHandler<SessionEnv>[] {
  return [
    corsPreflight({
      origins: config.corsOrigins,
      methods: CORS_METHODS,
      allowHeaders: CORS_ALLOW_HEADERS,
      maxAgeSeconds: CORS_MAX_AGE_SECONDS,
    }),
    securityHeaders,
    bodyParserLimit(config.bodyLimitBytes),
    requestIdMiddleware<SessionEnv>(),
  ];
}
