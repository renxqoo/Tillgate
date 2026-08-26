/**
 * DB 并发预算门（入口排队——公网 ingress 的通用架构件）：
 *
 * 池是稀缺资源，「并发检出 > 池容量」在任何运行时下都会劣化——node/pg 的
 * 检出队列在突发下吞吐塌陷（live-fire 10k:520/10000,p95 65s），Bun SQL 更是
 * 检出排队直接停摆在途事务（bun#38163/#38231,F-6）。本门把业务请求的 DB
 * 并发钳制在预算内：超发请求在进程内 FIFO 排队（事件循环健康等待,不占连接、
 * 不吃池超时），预算 = 池容量 − 余量（余量留给 fire-and-forget 写入与探针
 * 旁路的 DB 工作）。
 *
 * 探针（/healthz /livez /readyz）旁路——风暴期间 LB 探活不能排在请求后面
 * （否则实例被误判死亡摘除）。队列溢出与等待超时 fail-closed 503（客户端重试）。
 */
import type { MiddlewareHandler } from 'hono';
import { HttpErrors } from '../errors/catalog.js';

export interface DbBudgetOptions {
  /** 预算上限（同时进入业务链路的请求数,含其全部 DB 工作） */
  readonly limit: number;
  /** 队列上限（防无界积压打爆内存;超限立即 503 而非排队） */
  readonly maxQueue: number;
  /** 等待上限 ms（排队过久的请求以 503 拒绝,由客户端重试） */
  readonly waitTimeoutMs: number;
}

const BYPASS = new Set(['/healthz', '/livez', '/readyz']);

export function dbBudgetMiddleware(opts: DbBudgetOptions): MiddlewareHandler {
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
        // 统一错误出口:抛目录码(unavailable→503),由各 app 的 errorHandler face
        // 渲染信封/双语/Retry-After——机制件不自带出站形态(ADR-0001 D1)
        throw HttpErrors.business('db_budget_full', { queueDepth: queue.length, limit: opts.limit }, {
          retryAfterMs: opts.waitTimeoutMs,
        });
      }
      const granted = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = queue.indexOf(wake);
          if (i >= 0) queue.splice(i, 1);
          reject(
            HttpErrors.business('db_budget_timeout', { limit: opts.limit }, {
              retryAfterMs: opts.waitTimeoutMs,
            }),
          );
        }, opts.waitTimeoutMs);
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        queue.push(wake);
      });
      await granted;
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

/** 预算推导：limit = 池容量 − 余量（fireAndForgetMargin 按 app 的旁路 DB 工作量给） */
export function suggestDbBudget(
  poolMax: number,
  fireAndForgetMargin = 2,
): { limit: number; maxQueue: number; waitTimeoutMs: number } {
  return {
    limit: Math.max(1, poolMax - fireAndForgetMargin),
    maxQueue: 20_000,
    waitTimeoutMs: 120_000,
  };
}
