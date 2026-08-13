import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import type { RequestLifecycle } from '../services/runtime/request-lifecycle.js';

export interface GatewayHealthDeps {
  db: Db;
  redis: Redis;
  lifecycle: RequestLifecycle;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('health check timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** live 只看进程；ready 检查资金 DB、限流 Redis 和 drain 状态。 */
export function healthRoutes(deps: GatewayHealthDeps): Hono {
  return new Hono()
    .get('/livez', (c) => c.json({ status: 'ok' }))
    .get('/readyz', async (c) => {
      if (deps.lifecycle.isDraining) return c.json({ status: 'fail', reason: 'draining' }, 503);
      const checks = { postgres: 'down', redis: 'down', schema: 'down' } as Record<string, string>;
      try {
        await within(deps.db.execute(sql`select 1`), 1_000);
        checks.postgres = 'up';
        await within(
          deps.db.execute(sql`
            select revision, claim_token
            from billing_requests
            limit 0
          `),
          1_000,
        );
        checks.schema = 'up';
      } catch {
        // required dependency remains down
      }
      try {
        await within(deps.redis.ping(), 1_000);
        checks.redis = 'up';
      } catch {
        // rate limiting is a safety boundary and therefore required
      }
      const ready = Object.values(checks).every((value) => value === 'up');
      return c.json({ status: ready ? 'ok' : 'fail', checks }, ready ? 200 : 503);
    });
}
