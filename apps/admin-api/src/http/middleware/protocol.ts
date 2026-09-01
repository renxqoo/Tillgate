/**
 * 协议中间件三件套 消费 @tillgate/http：
 * CORS 预检（白名单空 = 不放行跨域）/ 安全响应头 / 请求体上限 / 服务端 requestId。
 * bodyParser 插件与限值同源（流式计数在读取侧强制）。
 */
import type { Plugin } from 'keala';
import {
  asMiddleware,
  bodyParser,
  bodyParserLimit,
  corsPreflight,
  requestIdMiddleware,
  securityHeaders,
  type Middleware,
} from '@tillgate/http';
import type { AdminContext } from './session';

export interface ProtocolConfig {
  readonly corsOrigins: readonly string[];
  readonly bodyLimitBytes: number;
}

/** 管理面预检参数（方法/头集合 = 管理台客户端实际使用面） */
const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const CORS_ALLOW_HEADERS = ['Authorization', 'Content-Type', 'Idempotency-Key'] as const;
const CORS_MAX_AGE_SECONDS = 600;

export interface ProtocolStack {
  /** body 读取 facade（先于路由注册安装） */
  readonly plugin: Plugin;
  /** 洋葱链（按序注册） */
  readonly chain: Middleware<AdminContext>[];
}

export function protocolStack(config: ProtocolConfig): ProtocolStack {
  return {
    plugin: bodyParser(config.bodyLimitBytes),
    chain: [
      corsPreflight({
        origins: config.corsOrigins,
        methods: CORS_METHODS,
        allowHeaders: CORS_ALLOW_HEADERS,
        maxAgeSeconds: CORS_MAX_AGE_SECONDS,
      }),
      securityHeaders,
      bodyParserLimit(config.bodyLimitBytes),
      asMiddleware(requestIdMiddleware()),
    ],
  };
}
