import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import type { Logger, WorkerEnv } from '@ai-gateway/core';
import { getTracer } from '@ai-gateway/core';
import { createDb, type Db } from '@ai-gateway/db';
import { bumpRouteCache } from '@ai-gateway/http';
import { notifyOutbox, users } from '@ai-gateway/db/schema';
import { maintainPartitions } from '@ai-gateway/tracing';
import { maintainRequestLogPartitions } from './request-log-partitions.js';
import { isDeepHealthAuthorized } from './health-gate.js';
import { settleTelemetry } from './settle-telemetry.js';
import {
  createBillingProcessor,
  createLedger,
  createRedisLedgerEffects,
  type BillingInventory,
  type BillingProcessor,
  BILLING_SETTLEMENT_QUEUE,
  type BillingSettlementWakeup,
} from '@ai-gateway/ledger';
import { runReferralCommissionOnce, runNotifyDispatchOnce } from './tasks/notify-referral.js';
import { runGenerationPollOnce } from './tasks/generation-poller.js';
import { createBilling, type Billing } from '@ai-gateway/ledger';
import {
  createAi,
  defaultAiConfig,
  MemoryKvStorage,
  type Ai,
  type BreakerState,
  type DeadCredentialState,
} from '@ai-gateway/ai';
import { mailerFromEnv } from '@ai-gateway/identity';

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
  const redisEffects = createRedisLedgerEffects(redis);
  const processor =
    deps.processor ??
    createBillingProcessor({
      db,
      effects: {
        balanceChanged: redisEffects.balanceChanged?.bind(redisEffects),
        // 结算成功 → TPM 回填 + 渠道进货额度熔断时清路由缓存（软闸立即生效）
        async usageSettled({ data, result }) {
          await redisEffects.usageSettled?.({ data, result });
          if (result.channelCircuitBroken && data.channelId != null) {
            await bumpRouteCache(redis).catch(() => {});
            logger.warn(
              { channelId: data.channelId },
              'channel upstream budget exhausted; circuit broken',
            );
          }
        },
        // 转 dead 即时告警：不变量被打破是缺陷信号，不允许静默积压在复核队列
        async requestDead(event) {
          logger.error(
            {
              requestId: event.requestId,
              userId: event.userId,
              failureClass: event.failureClass,
              lastError: event.lastError,
              reservedAmount: event.reservedAmount,
              attempt: event.attempt,
            },
            'billing request moved to dead; manual review required',
          );
          // 事务性发件箱：死单事件落箱（worker 投递到订阅渠道；best-effort 与日志双轨）
          await db
            .insert(notifyOutbox)
            .values({
              event: 'billing_dead',
              payload: {
                requestId: event.requestId,
                userId: event.userId,
                failureClass: event.failureClass,
                lastError: event.lastError,
                reservedAmount: event.reservedAmount,
                attempt: event.attempt,
              },
              dedupeKey: `billing-dead:${event.requestId}`,
            })
            .onConflictDoNothing()
            .catch(() => undefined);
        },
      },
      options: {
        ownerId: instanceId,
        batchSize: env.WORKER_CLAIM_BATCH_SIZE,
        concurrency: env.WORKER_CONCURRENCY,
        claimLeaseMs: env.WORKER_CLAIM_LEASE_MS,
        retryBaseMs: env.WORKER_RETRY_BASE_MS,
        retryMaxMs: env.WORKER_RETRY_MAX_MS,
        maxAttempts: env.WORKER_MAX_SETTLEMENT_ATTEMPTS,
        recoveryBatchSize: env.WORKER_RECOVERY_BATCH_SIZE,
        // 结算 span 以 trace_parent 挂回请求 trace（OTEL off 时 no-op 零开销）
        telemetry: settleTelemetry(getTracer('worker.billing')),
      },
    });
  const notifyMailer = mailerFromEnv(env, { brand: 'AI Gateway 运维告警', brandSub: 'AI GATEWAY · OPS' }) ?? undefined;
  const BALANCE_LOW_THRESHOLD = '5';
  const ledger = createLedger({
    db,
    effects: {
      ...createRedisLedgerEffects(redis),
      // 余额预警（按用户×日幂等入箱）：结算后余额低于阈值即提醒充值
      usageSettled: async ({ data, result }) => {
        if (Number(result.amount) <= 0) return;
        const [user] = await db
          .select({ balance: users.balance })
          .from(users)
          .where(eq(users.id, data.userId))
          .limit(1);
        const balance = Number(user?.balance ?? '0');
        if (balance < Number(BALANCE_LOW_THRESHOLD)) {
          await db
            .insert(notifyOutbox)
            .values({
              event: 'balance_low',
              payload: { userId: data.userId, balance: user?.balance ?? '0', requestId: data.requestId },
              dedupeKey: `balance-low:${data.userId}:${new Date().toISOString().slice(0, 10)}`,
            })
            .onConflictDoNothing()
            .catch(() => undefined);
        }
      },
    },
  });

  let queueWorker: Worker<BillingSettlementWakeup> | null = null;
  let healthServer: Server | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let traceMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let requestLogMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let referralTimer: ReturnType<typeof setInterval> | null = null;
  let generationTimer: ReturnType<typeof setInterval> | null = null;
  let notifyTimer: ReturnType<typeof setInterval> | null = null;
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
  const runReferralCommission = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const client = await db.$client.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock(hashtext('ai-gateway:referral-commission')) as acquired",
        );
        if (!lock.rows[0]?.acquired) return;
        try {
          const result = await runReferralCommissionOnce(db, ledger, {
            commissionRate: env.REFERRAL_COMMISSION_RATE,
          });
          if (result.credited > 0) logger.info({ credited: result.credited }, 'referral commission settled');
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:referral-commission'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'referral commission failed'));
  };

  const runNotifyDispatch = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const client = await db.$client.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock(hashtext('ai-gateway:notify-dispatch')) as acquired",
        );
        if (!lock.rows[0]?.acquired) return;
        try {
          const result = await runNotifyDispatchOnce(db, logger, notifyMailer);
          if (result.sent > 0 || result.failed > 0) {
            logger.info(result, 'notify dispatched');
          }
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:notify-dispatch'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'notify dispatch failed'));
  };

  /**
   * 异步生成任务轮询（video 状态查询 + music 代执行 + 续租 + 超时）。
   * 同 referral/notify：advisory lock 只让一个副本执行整轮，任务行 CAS 兜底。
   * ai 实例按需构造（Redis 可用时共享熔断存储，降级用内存存储——轮询量级低）。
   */
  let generationAi: Ai | null = null;
  let generationBilling: Billing | null = null;
  const runGenerationPoll = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const client = await db.$client.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock(hashtext('ai-gateway:generation-poll')) as acquired",
        );
        if (!lock.rows[0]?.acquired) return;
        try {
          // 内存状态存储（与 admin 渠道探测同取舍）：轮询量级低且刻意与 gateway
          // 的 Redis 共享熔断隔离——任务轮询的渠道判定不放大网关侧熔断计数。
          generationAi ??= createAi(
            {
              ...defaultAiConfig(),
              allowLocalUrl: env.ALLOW_LOCAL_UPSTREAM && env.NODE_ENV !== 'production',
              allowedHosts: env.UPSTREAM_HOST_ALLOWLIST,
            },
            {
              breakerStorage: new MemoryKvStorage<BreakerState>(),
              deadCredentialStorage: new MemoryKvStorage<DeadCredentialState>(),
            },
          );
          generationBilling ??= createBilling({ db });
          const result = await runGenerationPollOnce(
            { db, ai: generationAi, billing: generationBilling, logger, batch: env.WORKER_GENERATION_BATCH,
              leaseMs: Math.max(env.WORKER_GENERATION_POLL_INTERVAL_MS * 3, 30_000) },
            { encryptionKey: env.ENCRYPTION_KEY, encryptionKeyOld: env.ENCRYPTION_KEY_OLD },
          );
          if (result.succeeded + result.failed + result.expired > 0) {
            logger.info(result, 'generation tasks progressed');
          }
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:generation-poll'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'generation poll failed'));
  };

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
          if (result.discrepancies > 0) {
            logger.error({ result }, 'reconciliation discrepancies');
            await db
              .insert(notifyOutbox)
              .values({
                event: 'reconcile_discrepancy',
                payload: { discrepancies: result.discrepancies },
                dedupeKey: `reconcile-discrepancy:${new Date().toISOString().slice(0, 13)}`,
              })
              .onConflictDoNothing()
              .catch(() => undefined);
          }
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:billing-reconcile'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'reconcile failed'));
  };

  /** trace_spans 分区维护：预建未来 + 清理超期；advisory lock 保证多副本只跑一份。 */
/** request_logs 月分区维护：advisory lock 防多实例并发，逻辑在 request-log-partitions.ts（可测） */
  const runRequestLogMaintenance = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const client = await db.$client.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock(hashtext('ai-gateway:request-log-partition')) as acquired",
        );
        if (!lock.rows[0]?.acquired) return;
        try {
          const result = await maintainRequestLogPartitions(client, {
            retentionDays: env.REQUEST_LOG_RETENTION_DAYS,
          });
          if (result.created.length + result.dropped.length > 0) {
            logger.info({ result }, 'request_logs partitions maintained');
          }
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:request-log-partition'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'request-log partition maintenance failed'));
  };


  const runTraceMaintenance = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const client = await db.$client.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock(hashtext('ai-gateway:trace-partition')) as acquired",
        );
        if (!lock.rows[0]?.acquired) return;
        try {
          const result = await maintainPartitions(db, { retentionDays: env.TRACE_RETENTION_DAYS });
          if (result.created.length + result.dropped.length > 0) {
            logger.info({ result }, 'trace partitions maintained');
          }
        } finally {
          await client.query("select pg_advisory_unlock(hashtext('ai-gateway:trace-partition'))");
        }
      } finally {
        client.release();
      }
    }).catch((error) => logger.warn({ err: (error as Error).message }, 'trace partition maintenance failed'));
  };

  const runRecovery = async (): Promise<void> => {
    if (!accepting) return;
    await track(async () => {
      const result = await processor.recoverOnce();
      inventory = await processor.inventory();
      lastRecoveryAt = new Date();
      lastRecoveryError = null;
      postgres = 'up';
      if (result.released + result.claimsRequeued > 0) {
        logger.info({ result }, 'billing recovery completed');
      }
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
        : redisState === 'down' || inventory.dead > 0
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
          // G2：深度健康报告含结算积压/lastError 等内部信息——须带令牌访问；
          // livez/readyz 保持开放（编排器探针语义，无敏感字段）。
          if (kind === 'deep') {
            const provided = Array.isArray(request.headers['x-health-token'])
              ? request.headers['x-health-token'][0]
              : request.headers['x-health-token'];
            if (!isDeepHealthAuthorized(provided, process.env.WORKER_HEALTH_TOKEN)) {
              response.writeHead(403, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                  error: { message: '深度健康报告需要令牌', code: 'WORKER_HEALTH_TOKEN_REQUIRED' },
                }),
              );
              return;
            }
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
              response.end(
                JSON.stringify({
                  status: 'fail',
                  error: { message: (error as Error).message, code: 'HEALTH_REPORT_FAILED' },
                }),
              );
            });
        });
        await new Promise<void>((resolve, reject) => {
          healthServer!.once('error', reject);
          healthServer!.listen(env.WORKER_HEALTH_PORT, resolve);
        });

        pollTimer = setInterval(() => void runSettlement(), env.WORKER_POLL_INTERVAL_MS);
        recoveryTimer = setInterval(() => void runRecovery(), env.WORKER_RECOVERY_INTERVAL_MS);
        reconcileTimer = setInterval(() => void runReconcile(), env.WORKER_RECONCILE_INTERVAL_MS);
        referralTimer = setInterval(() => void runReferralCommission(), env.WORKER_REFERRAL_INTERVAL_MS);
        notifyTimer = setInterval(() => void runNotifyDispatch(), env.WORKER_NOTIFY_INTERVAL_MS);
        generationTimer = setInterval(
          () => void runGenerationPoll(),
          env.WORKER_GENERATION_POLL_INTERVAL_MS,
        );
        traceMaintenanceTimer = setInterval(
          () => void runTraceMaintenance(),
          env.WORKER_TRACE_MAINTENANCE_INTERVAL_MS,
        );
        requestLogMaintenanceTimer = setInterval(
          () => void runRequestLogMaintenance(),
          env.WORKER_TRACE_MAINTENANCE_INTERVAL_MS,
        );
        pollTimer.unref();
        requestLogMaintenanceTimer.unref();
        recoveryTimer.unref();
        reconcileTimer.unref();
        generationTimer.unref();
        traceMaintenanceTimer.unref();
        started = true;
        logger.info({ instanceId, healthPort: env.WORKER_HEALTH_PORT }, 'billing worker ready');
        return { instanceId };
      } catch (error) {
        accepting = false;
        if (pollTimer) clearInterval(pollTimer);
        if (recoveryTimer) clearInterval(recoveryTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        if (referralTimer) clearInterval(referralTimer);
        if (notifyTimer) clearInterval(notifyTimer);
        if (generationTimer) clearInterval(generationTimer);
        if (generationTimer) clearInterval(generationTimer);
        if (traceMaintenanceTimer) clearInterval(traceMaintenanceTimer);
        if (requestLogMaintenanceTimer) clearInterval(requestLogMaintenanceTimer);
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
        if (referralTimer) clearInterval(referralTimer);
        if (notifyTimer) clearInterval(notifyTimer);
        if (generationTimer) clearInterval(generationTimer);
        if (traceMaintenanceTimer) clearInterval(traceMaintenanceTimer);
        if (requestLogMaintenanceTimer) clearInterval(requestLogMaintenanceTimer);
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
