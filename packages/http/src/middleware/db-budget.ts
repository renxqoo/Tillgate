/**
 * DB 并发预算门（入口排队——公网 ingress 的通用架构件）：
 *
 * 池是稀缺资源，「并发检出 > 池容量」在任何运行时下都会劣化——node/pg 的
 * 检出队列在突发下吞吐塌陷（live-fire 10k:520/10000,p95 65s），Bun SQL 更是
 * 检出排队直接停摆在途事务（bun#38163/#38231）。本门把业务请求的 DB
 * 并发钳制在预算内：超发请求在进程内 FIFO 排队（事件循环健康等待,不占连接、
 * 不吃池超时），预算 = 池容量 − 余量（余量留给 fire-and-forget 写入与探针
 * 旁路的 DB 工作）。
 *
 * 排队等待有四条出路、恰好一条生效：release 授予 / 等待超时 / 客户端断连 /
 * 停机排水。断连出局不占预算、不执行业务链——死连接被授予只会产出幻影负载
 * （响应无处可去,业务/计费照跑）;排水出局让停机宽限不必陪排队者等满
 * waitTimeout。每条出路同步拆除其余唤醒源（timer/abort 监听）,drainSignal
 * 全进程恰一个 once 监听——零泄漏（方案:docs/db-budget-signals/DESIGN.md）。
 *
 * 探针（/healthz /livez /readyz）旁路优先于一切取消路径——风暴与停机期
 * LB 探活不能排在请求后面（否则实例被误判死亡摘除）。队列溢出与等待超时
 * fail-closed 503（客户端重试）。
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
  /** 停机排水信号（可选,装配注入）：abort 时全体排队者立即出局、后续新到立即拒流 */
  readonly drainSignal?: AbortSignal;
}

/** 队列项：release 授予（grant）或取消路径调用（revoke）——恰好一条出路 */
interface BudgetWaiter {
  grant(): void;
  revoke(error: unknown): void;
}

const BYPASS = new Set(['/healthz', '/livez', '/readyz']);

// eslint-disable-next-line max-lines-per-function -- 排队/超时/取消共享 inflight/queue 闭包状态,拆段即互相回读
export function dbBudgetMiddleware(opts: DbBudgetOptions): MiddlewareHandler {
  let inflight = 0;
  const queue: Array<BudgetWaiter> = [];
  const release = (): void => {
    inflight -= 1;
    const next = queue.shift();
    if (next != null) {
      inflight += 1;
      next.grant();
    }
  };

  /** 排队等待：四条出路（授予/超时/断连/排水）恰一条;出局同步拆除其余唤醒源 */
  const enqueue = (client: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const waiter: BudgetWaiter = {
        grant(): void {
          cleanup();
          resolve();
        },
        revoke(error: unknown): void {
          cleanup();
          reject(error);
        },
      };
      const exitQueue = (): void => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
      };
      const timer = setTimeout(() => {
        exitQueue();
        waiter.revoke(
          HttpErrors.business(
            'db_budget_timeout',
            { limit: opts.limit },
            {
              retryAfterMs: opts.waitTimeoutMs,
            },
          ),
        );
      }, opts.waitTimeoutMs);
      const onAbort = (): void => {
        exitQueue();
        waiter.revoke(
          HttpErrors.business(
            'db_budget_abandoned',
            { limit: opts.limit },
            {
              retryAfterMs: opts.waitTimeoutMs,
            },
          ),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        client.removeEventListener('abort', onAbort);
      };
      client.addEventListener('abort', onAbort);
      queue.push(waiter);
    });

  // 停机排水：恰一个 once 监听,abort 时清空队列（新到请求走入口检查立即拒）
  opts.drainSignal?.addEventListener(
    'abort',
    () => {
      while (queue.length > 0) {
        queue.shift()?.revoke(
          HttpErrors.business(
            'db_budget_draining',
            { limit: opts.limit },
            {
              retryAfterMs: opts.waitTimeoutMs,
            },
          ),
        );
      }
    },
    { once: true },
  );

  return async (c, next) => {
    if (BYPASS.has(c.req.path)) return next();
    if (opts.drainSignal?.aborted === true) {
      // 统一错误出口:抛目录码(unavailable→503),由各 app 的 errorHandler face
      // 渲染信封/双语/Retry-After——机制件不自带出站形态
      throw HttpErrors.business(
        'db_budget_draining',
        { limit: opts.limit },
        {
          retryAfterMs: opts.waitTimeoutMs,
        },
      );
    }
    if (c.req.raw.signal.aborted) {
      throw HttpErrors.business(
        'db_budget_abandoned',
        { limit: opts.limit },
        {
          retryAfterMs: opts.waitTimeoutMs,
        },
      );
    }
    if (inflight >= opts.limit) {
      if (queue.length >= opts.maxQueue) {
        throw HttpErrors.business(
          'db_budget_full',
          { queueDepth: queue.length, limit: opts.limit },
          {
            retryAfterMs: opts.waitTimeoutMs,
          },
        );
      }
      await enqueue(c.req.raw.signal);
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
