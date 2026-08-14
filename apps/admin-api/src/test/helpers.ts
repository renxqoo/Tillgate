import { Hono } from 'hono';
import { createBillingOperations, createLedger } from '@ai-gateway/ledger';
import { createPgTraceStore } from '@ai-gateway/tracing';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/core';
import { errorHandler, type Redis } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import type { VoucherStorage } from '../services/voucher-storage.js';

/**
 * admin-api 测试辅助：组装 stub 依赖与测试用 app。
 *
 * makeAdminTestApp 与 createApp 同构（受保护子应用 + 中间件），
 * 只是把 adminAuthMiddleware 换成直接注入固定 adminId 的 stub——
 * 集成测试专注业务逻辑，鉴权链路由 set-password / password-hash-leak 等测试单独覆盖。
 */

export const TEST_ADMIN_ID = 1;
export const TEST_ENCRYPTION_KEY = 'a'.repeat(32);

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

/** 内存版 Redis stub：覆盖 admin-api 用到的 incr/del（静默成功） */
export function stubRedis(): Redis {
  return {
    incr: async () => 1,
    del: async () => 1,
  } as unknown as Redis;
}

/** 内存版凭证存储 stub（测试用，不落磁盘） */
export function stubVoucherStorage(): VoucherStorage {
  const map = new Map<string, { data: Uint8Array; mimeType: string }>();
  let seq = 0;
  return {
    async save(data, mimeType) {
      const key = `test-${++seq}-${mimeType.split('/')[1]}`;
      map.set(key, { data, mimeType });
      return key;
    },
    async load(key) {
      return map.get(key) ?? null;
    },
  };
}

export function makeServices(db: Db, overrides: Partial<AdminServices> = {}): AdminServices {
  return {
    db,
    redis: stubRedis(),
    ledger: createLedger({ db }),
    billingOperations: createBillingOperations({ db }),
    tracingStore: createPgTraceStore(db),
    encryptionKey: TEST_ENCRYPTION_KEY,
    voucherStorage: stubVoucherStorage(),
    allowLocalUpstream: false,
    logger: noopLogger(),
    ...overrides,
  };
}

/**
 * 组装测试 app：受保护子应用挂载给定路由组（prefix → 路由工厂），stub 注入固定 adminId。
 * 与 createApp 同构：prefix 即 /api/admin 下的资源前缀（如 '/channels'、'/models'）。
 */
export function makeAdminTestApp(
  mounts: Record<string, Hono<AdminEnv>>,
  options: { adminId?: number } = {},
): Hono {
  const adminId = options.adminId ?? TEST_ADMIN_ID;
  const app = new Hono();
  app.onError(errorHandler(noopLogger()));
  const admin = new Hono<AdminEnv>();
  admin.use('*', async (c, next) => {
    c.set('adminId', adminId);
    await next();
  });
  for (const [prefix, route] of Object.entries(mounts)) {
    admin.route(prefix, route);
  }
  app.route('/api/admin', admin);
  return app;
}
