/**
 * DB 并发预算门（万级并发形态的入口排队）：
 *
 * 池是稀缺资源（DB_POOL_MAX），任何形态下「并发检出 > 池容量」都会劣化——
 * node/pg 的检出队列在高压下吞吐塌陷（live-fire 10k:520/10000,p95 65s），
 * Bun SQL 更是检出排队直接停摆在途事务（bun#38163/#38231,F-6）。本门把
 * 业务请求的 DB 并发钳制在预算内：超发的请求在进程内 FIFO 排队（事件循环
 * 健康等待,不占连接、不吃池超时），预算 = 池容量 − 余量（余量留给
 * fire-and-forget 请求日志插入与探针旁路）。
 *
 * 探针（/healthz /livez /readyz）与网关控制面旁路——万级风暴期间 LB 探活
 * 不能排在 10000 个请求后面（否则实例被误判死亡摘除）。
 */
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from './api-key';

export interface DbBudgetOptions {
  /** 预算上限（同时进入业务链路的请求数,含其全部 DB 工作） */
  readonly limit: number;
  /** 队列上限（防无界积压打爆内存;超限立即 503 而非排队） */
  readonly maxQueue: number;
  /** 等待上限 ms（排队过久的请求以 503 拒绝,由客户端重试） */
  readonly waitTimeoutMs: number;
}

const BYPASS = new Set(['/healthz', '/livez', '/readyz']);

export function dbBudgetMiddleware(opts: DbBudgetOptions): MiddlewareHandler<AuthEnv> {
  let inflight = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    inflight -= 1;
    const next = queue.shift();
    if (next != null) {
      inflight += 1;
      next();
    }
  };
  return async (c, next) => {
    if (BYPASS.has(c.req.path)) return next();
    if (inflight >= opts.limit) {
      if (queue.length >= opts.maxQueue) {
        return c.json({ error: { code: 'gateway.db_budget_full', message: 'DB concurrency budget queue full' } }, 503);
      }
      const granted = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = queue.indexOf(wake);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error('db budget wait timeout'));
        }, opts.waitTimeoutMs);
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        queue.push(wake);
      });
      try {
        await granted;
      } catch {
        return c.json({ error: { code: 'gateway.db_budget_timeout', message: 'DB concurrency budget wait timeout' } }, 503);
      }
    } else {
      inflight += 1;
    }
    try {
      return await next();
    } finally {
      release();
    }
  };
}
