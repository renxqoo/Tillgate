import { Hono } from 'hono';
import { createLedger } from '@ai-gateway/ledger';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/core';
import { errorHandler, type Redis } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import type { ClientApiConfig } from '../config.js';

/**
 * client-api 测试辅助：组装 stub 依赖与测试用 app。
 *
 * makeClientTestApp 与 createApp 同构（受保护子应用 + 中间件），
 * 只是把 userSessionMiddleware 换成直接注入固定 userId 的 stub——
 * 集成测试专注业务逻辑，会话鉴权由 identity 包单元测试覆盖。
 */

export const TEST_USER_ID = 1;

export function noopLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
  } as unknown as Logger;
}

/** 内存版 Redis stub：覆盖 client-api 用到的 incr/expire/ttl/del（限流类测试请注入真实 Redis） */
export function stubRedis(): Redis {
  return {
    incr: async () => 1,
    expire: async () => 1,
    ttl: async () => 60,
    del: async () => 1,
    hset: async () => 1,
  } as unknown as Redis;
}

export function makeServices(db: Db, overrides: Partial<ClientServices> = {}): ClientServices {
  return {
    db,
    redis: stubRedis(),
    ledger: createLedger({ db }),
    logger: noopLogger(),
    mailer: null,
    captcha: null,
    ...overrides,
  };
}

export function makeTestConfig(overrides: Partial<ClientApiConfig> = {}): ClientApiConfig {
  return {
    jwtSecret: 'test-jwt-secret-0123456789-abcdef',
    secureCookie: false,
    giftAmount: 0,
    trustedOrigins: [],
    trustedProxyHops: 1, // 测试信任单跳：单条 XFF 即客户端 IP（模拟代理后部署）
    oauth: { frontendUrl: 'http://localhost:3001', apiBase: 'http://localhost:8791', github: null, google: null },
    ...overrides,
  };
}

/** 受保护子应用测试 app：stub 注入固定 userId，挂载 prefix → 路由组 */
export function makeClientTestApp(userId: number, mounts: Record<string, Hono<ClientEnv>>): Hono {
  const app = new Hono();
  app.onError(errorHandler(noopLogger()));
  const api = new Hono<ClientEnv>();
  api.use('*', async (c, next) => {
    c.set('session', { userId });
    await next();
  });
  for (const [prefix, route] of Object.entries(mounts)) {
    api.route(prefix, route);
  }
  app.route('/api', api);
  return app;
}

/** 公开端点测试 app（登录/注销等，无会话守护） */
export function makeClientPublicApp(mounts: Record<string, Hono<ClientEnv>>): Hono<ClientEnv> {
  const app = new Hono<ClientEnv>();
  app.onError(errorHandler(noopLogger()));
  for (const [prefix, route] of Object.entries(mounts)) {
    app.route(prefix, route);
  }
  return app;
}
