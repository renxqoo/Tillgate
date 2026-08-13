import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { sql } from 'drizzle-orm';
import type { Logger, WorkerEnv } from '@ai-gateway/core';
import { createDb, type Db } from '@ai-gateway/db';
import {
  createBillingProcessor,
  createLedger,
  createRedisLedgerEffects,
  type BillingInventory,
  type BillingProcessor,
  BILLING_SETTLEMENT_QUEUE,
  type BillingSettlementWakeup,
} from '@ai-gateway/ledger';

export interface WorkerHealth {
  status: 'ok' | 'degraded' | 'fail';
  instanceId: string;
  accepting: boolean;
  active: number;
  dependencies: { postgres: 'up' | 'down'; redis: 'up' | 'down' };
  settlement: BillingInventory;
  recovery: { lastSuccessAt: string | null; lastError: string | null };
}

export interface StopReport {
  clean: boolean;
  activeAbandoned: number;
  elapsedMs: number;
}

export interface BillingWorkerApplication {
  start(): Promise<{ instanceId: string }>;
  stop(input: { reason: 'SIGTERM' | 'SIGINT' | 'fatal'; deadlineMs: number }): Promise<StopReport>;
  health(kind: 'live' | 'ready' | 'deep'): Promise<WorkerHealth>;
}

interface RuntimeDeps {
  env: WorkerEnv;
  logger: Logger;
  db?: Db;
  redis?: IORedis;
  processor?: BillingProcessor;
  telemetryShutdown?: () => Promise<void>;
}

const emptyInventory = (): BillingInventory => ({
  pending: 0,
  processing: 0,
  retrying: 0,
  dead: 0,
  uncertain: 0,
  oldestPendingMs: 0,
});

function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
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

/** Worker 的深生命周期门面：index.ts 只调用 start/stop/health。 */
export function createBillingWorkerApplication(deps: RuntimeDeps): BillingWorkerApplication {
  const { env, logger } = deps;
  const instanceId = env.WORKER_INSTANCE_ID ?? `worker:${randomUUID()}`;
  const db = deps.db ?? createDb(env.DATABASE_URL);
  const redis =
    deps.redis ??
    new IORedis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(5_000, attempt * 250),
    });
  const processor =
    deps.processor ??
    createBillingProcessor({
      db,
      effects: createRedisLedgerEffects(redis),
      options: {
        ownerId: instanceId,
        batchSize: env.WORKER_CLAIM_BATCH_SIZE,
        concurrency: env.WORKER_CONCURRENCY,
        claimLeaseMs: env.WORKER_CLAIM_LEASE_MS,
        retryBaseMs: env.WORKER_RETRY_BASE_MS,
        retryMaxMs: env.WORKER_RETRY_MAX_MS,
        maxAttempts: env.WORKER_MAX_SETTLEMENT_ATTEMPTS,
        recoveryBatchSize: env.WORKER_RECOVERY_BATCH_SIZE,
      },
    });
  const ledger = createLedger({ db, effects: createRedisLedgerEffects(redis) });

  let queueWorker: Worker<BillingSettlementWakeup> | null = null;
  let healthServer: Server | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let accepting = false;
  let started = false;
  let stopping: Promise<StopReport> | null = null;
  let active = 0;
  let postgres: 'up' | 'down' = 'down';
  let redisState: 'up' | 'down' = 'down';
  let lastLoopAt = 0;
  let lastRecoveryAt: Date | null = null;
  let lastRecoveryError: string | null = null;
  let inventory = emptyInventory();
  let settlementPump: Promise<void> | null = null;
  const pendingKicks = new Set<string>();
  let settlementLastError: string | null = null;
  const idleWaiters = new Set<() => void>();

  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      if (active === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  };

  const runSettlement = (requestIds?: string[]): Promise<void> => {
    for (const requestId of requestIds ?? []) pendingKicks.add(requestId);
    if (!accepting) return Promise.resolve();
    if (settlementPump) return settlementPump;
    settlementPump = track(async () => {
      const totals = { claimed: 0, settled: 0, retried: 0, dead: 0, claimLost: 0 };
      const timeBudgetEnds =
        Date.now() + Math.max(250, Math.floor(env.WORKER_POLL_INTERVAL_MS / 2));
      do {
        const kicked = pendingKicks.size
          ? Array.from(pendingKicks).slice(0, env.WORKER_CLAIM_BATCH_SIZE)
          : undefined;
        for (const requestId of kicked ?? []) pendingKicks.delete(requestId);
        const result = await processor.runOnce(kicked);
        for (const key of Object.keys(totals) as Array<keyof typeof totals>)
          totals[key] += result[key];
        if (kicked && pendingKicks.size > 0) continue;
        if (result.claimed < Math.min(env.WORKER_CLAIM_BATCH_SIZE, env.WORKER_CONCURRENCY)) break;
      } while (Date.now() < timeBudgetEnds);
      lastLoopAt = Date.now();
      settlementLastError = null;
      postgres = 'up';
      if (totals.claimed > 0) logger.info({ result: totals }, 'settlement batch processed');
      if (totals.dead > 0) logger.error({ result: totals }, 'settlements moved to dead review');
    })
      .catch((error) => {
        postgres = 'down';
        settlementLastError = (error as Error).message;
        logger.error({ err: settlementLastError }, 'settlement loop failed');
      })
      .finally(() => {
        settlementPump = null;
        if (accepting && pendingKicks.size > 0) void runSettlement();
      });
    return settlementPump;
  };

  /** 只让一个副本执行昂贵全量对账；专用 PG 会话持有 advisory lock。 */
  const runReconcile = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const client = await db.$client.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock(hashtext('ai-gateway:billing-reconcile')) as acquired",
        );
        if (!lock.rows[0]?.acquired) return;
        try {
          const result = await ledger.reconcile({ scope: 'all' });
          if (result.discrepancies > 0) logger.error({ result }, 'reconciliation discrepancies');
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:billing-reconcile'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'reconcile failed'));
  };

  const runRecovery = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const result = await processor.recoverOnce();
      inventory = await processor.inventory();
      lastRecoveryAt = new Date();
      lastRecoveryError = null;
      postgres = 'up';
      if (result.released + result.uncertain + result.claimsRequeued > 0) {
        logger.info({ result }, 'billing recovery completed');
      }
      if (result.uncertain > 0) logger.error({ result }, 'billing requests require review');
    }).catch((error) => {
      postgres = 'down';
      lastRecoveryError = (error as Error).message;
      logger.error({ err: lastRecoveryError }, 'billing recovery failed');
    });
  };

  const healthReport = async (kind: 'live' | 'ready' | 'deep'): Promise<WorkerHealth> => {
    if (kind !== 'live') {
      try {
        await deadline(db.execute(sql`select 1`), 1_000, 'postgres health timeout');
        postgres = 'up';
      } catch {
        postgres = 'down';
      }
      if (kind === 'deep') {
        try {
          await deadline(redis.ping(), 1_000, 'redis health timeout');
          redisState = 'up';
        } catch {
          redisState = 'down';
        }
        try {
          inventory = await processor.inventory();
        } catch {
          postgres = 'down';
        }
      }
    }
    if (kind === 'live') {
      return {
        status: started ? 'ok' : 'fail',
        instanceId,
        accepting,
        active,
        dependencies: { postgres, redis: redisState },
        settlement: inventory,
        recovery: {
          lastSuccessAt: lastRecoveryAt?.toISOString() ?? null,
          lastError: lastRecoveryError,
        },
      };
    }
    const stale = started && Date.now() - lastLoopAt > env.WORKER_LOOP_STALE_MS;
    const status =
      !started || postgres === 'down' || !accepting || stale
        ? 'fail'
        : redisState === 'down' || inventory.dead > 0 || inventory.uncertain > 0
          ? 'degraded'
          : 'ok';
    return {
      status,
      instanceId,
      accepting,
      active,
      dependencies: { postgres, redis: redisState },
      settlement: inventory,
      recovery: {
        lastSuccessAt: lastRecoveryAt?.toISOString() ?? null,
        lastError: settlementLastError ?? lastRecoveryError,
      },
    };
  };

  return {
    async start() {
      if (started) return { instanceId };
      try {
        await deadline(db.execute(sql`select 1`), 5_000, 'postgres startup timeout');
        postgres = 'up';
        // Redis/队列是可降级加速层，连接失败不能阻止 DB poller 启动。
        try {
          if (redis.status === 'wait')
            await deadline(redis.connect(), 3_000, 'redis startup timeout');
          redisState = 'up';
          queueWorker = new Worker<BillingSettlementWakeup>(
            BILLING_SETTLEMENT_QUEUE,
            async (job) => runSettlement([job.data.requestId]),
            { connection: redis, concurrency: env.WORKER_CONCURRENCY },
          );
          queueWorker.on('failed', (job, error) =>
            logger.warn(
              { jobId: job?.id, err: error.message },
              'billing wakeup failed; DB poll recovers',
            ),
          );
          queueWorker.on('error', (error) => {
            redisState = 'down';
            logger.warn({ err: error.message }, 'billing queue degraded');
          });
        } catch (error) {
          redisState = 'down';
          logger.warn(
            { err: (error as Error).message },
            'billing queue unavailable; using DB poll',
          );
        }

        accepting = true;
        lastLoopAt = Date.now();
        await runRecovery();
        await runSettlement();

        healthServer = createServer((request, response) => {
          const kind =
            request.url === '/livez' ? 'live' : request.url === '/readyz' ? 'ready' : 'deep';
          if (!['/livez', '/readyz', '/health'].includes(request.url ?? '')) {
            response.writeHead(404).end();
            return;
          }
          void healthReport(kind)
            .then((report) => {
              response.writeHead(report.status === 'fail' ? 503 : 200, {
                'content-type': 'application/json',
              });
              response.end(JSON.stringify(report));
            })
            .catch((error) => {
              response.writeHead(503, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ status: 'fail', error: (error as Error).message }));
            });
        });
        await new Promise<void>((resolve, reject) => {
          healthServer!.once('error', reject);
          healthServer!.listen(env.WORKER_HEALTH_PORT, resolve);
        });

        pollTimer = setInterval(() => void runSettlement(), env.WORKER_POLL_INTERVAL_MS);
        recoveryTimer = setInterval(() => void runRecovery(), env.WORKER_RECOVERY_INTERVAL_MS);
        reconcileTimer = setInterval(() => void runReconcile(), env.WORKER_RECONCILE_INTERVAL_MS);
        pollTimer.unref();
        recoveryTimer.unref();
        reconcileTimer.unref();
        started = true;
        logger.info({ instanceId, healthPort: env.WORKER_HEALTH_PORT }, 'billing worker ready');
        return { instanceId };
      } catch (error) {
        accepting = false;
        if (pollTimer) clearInterval(pollTimer);
        if (recoveryTimer) clearInterval(recoveryTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        await Promise.allSettled([
          queueWorker?.close() ?? Promise.resolve(),
          processor.abandonOwnedClaims(),
          new Promise<void>((resolve) => {
            if (!healthServer?.listening) return resolve();
            healthServer.closeAllConnections?.();
            healthServer.close(() => resolve());
          }),
          redis.status === 'end' ? Promise.resolve() : redis.quit(),
          db.$client.end(),
          deps.telemetryShutdown?.() ?? Promise.resolve(),
        ]);
        throw error;
      }
    },

    async stop({ reason, deadlineMs }) {
      if (stopping) return stopping;
      stopping = (async () => {
        const begin = Date.now();
        const endsAt = begin + deadlineMs;
        const remaining = (): number => Math.max(1, endsAt - Date.now());
        accepting = false;
        if (pollTimer) clearInterval(pollTimer);
        if (recoveryTimer) clearInterval(recoveryTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        logger.info({ reason }, 'billing worker draining');
        let clean = true;
        let activeAbandoned = 0;
        const phase = async (name: string, work: () => Promise<void>): Promise<void> => {
          try {
            await deadline(work(), remaining(), `${name} timeout`);
          } catch (error) {
            clean = false;
            logger.warn(
              { phase: name, err: (error as Error).message },
              'worker shutdown phase failed',
            );
          }
        };

        await phase('queue close', () => queueWorker?.close() ?? Promise.resolve());
        await phase('active drain', async () => {
          if (active === 0) return;
          await new Promise<void>((resolve) => idleWaiters.add(resolve));
        });
        if (active > 0) {
          await phase('claim handoff', async () => {
            activeAbandoned = await processor.abandonOwnedClaims();
            logger.warn(
              { active, returned: activeAbandoned },
              'active settlement claims handed back for retry',
            );
          });
        }
        await phase('redis close', async () => {
          if (redis.status !== 'end') await redis.quit();
        });
        await phase('telemetry flush', () => deps.telemetryShutdown?.() ?? Promise.resolve());
        await phase('database close', () => db.$client.end());
        await phase('health close', async () => {
          if (!healthServer) return;
          healthServer.closeAllConnections?.();
          await new Promise<void>((resolve, reject) =>
            healthServer!.close((error) => (error ? reject(error) : resolve())),
          );
        });
        started = false;
        return { clean, activeAbandoned, elapsedMs: Date.now() - begin };
      })();
      return stopping;
    },

    health: healthReport,
  };
}
