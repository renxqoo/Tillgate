/**
 * worker 入口：事件驱动结算（PG LISTEN/NOTIFY settle-wake 唤醒，毫秒级）+ 八定时器兜底
 * （结算扫描 + 滞留回收 + 生成任务轮询 + 佣金日结 + 告警投递 + 周期对账 +
 * trace/request_logs 分区维护），健康端点 + 优雅停机。
 * 业务全部来自 service/wallet/tracing 包；本文件只有节奏与生命周期。
 * 账务正确性不依赖消息：认领/幂等全在 DB，唤醒通道故障退化为兜底扫描节奏。
 */
import { createDb, notifyOutbox, type Db } from '@ai-gateway/db';
import {
  assertRedisReachable,
  createRedisClient,
  createSlidingWindowLimiter,
  initOtel,
} from '@ai-gateway/core';
import { createRepositories } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { mailerFromEnv } from '@ai-gateway/identity';
import {
  createBillingDomain,
  createGenerationPollUseCase,
  createSettlementDomain,
  createWallet,
  systemContext,
} from '@ai-gateway/service';
import { loadConfig, resolveWorkerConfig, type WorkerConfig } from './config.js';
import { createRunOnce } from './run-once.js';
import { createTaskAdapter } from './generation-adapter.js';
import { runReferralCommissionOnce } from './tasks/referral-commission.js';
import { runNotifyDispatchOnce } from './tasks/notify-dispatch.js';
import { runReconcileOnce } from './tasks/reconcile.js';
import {
  runRequestLogPartitionMaintenance,
  runTracePartitionMaintenance,
} from './tasks/partition-maintenance.js';
import { startHealthServer } from './health.js';
import { createSettleWakeupConsumer } from './wakeup.js';

/** 实例登记（排障探针）：进程内活着的 startWorker 实例——多实例即泄漏源 */
export const liveWorkerInstances: { owner: string; startedAt: number }[] = [];

export interface WorkerHandles {
  stop(): Promise<void>;
  /** 观测探针（测试）：唤醒 consumer 是否存在（排障 stop 语义用） */
  hasWakeConsumer(): boolean;
}

export async function startWorker(
  rawConfig: WorkerConfig | Record<string, unknown>,
  dbInput?: Db,
): Promise<WorkerHandles> {
  // 入口归一化：内联配置（e2e/嵌入）与 env 加载同一 schema 事实源——
  // 缺字段填默认、非法值 fail-closed，杜绝 undefined 静默落进定时器
  const config = resolveWorkerConfig(rawConfig as Record<string, unknown>);
  const db = dbInput ?? createDb(config.DATABASE_URL, { poolMax: config.WORKER_BATCH_SIZE + 5 });
  const ctx = systemContext(config.WORKER_OWNER_ID);
  const repos = createRepositories();
  liveWorkerInstances.push({ owner: config.WORKER_OWNER_ID, startedAt: Date.now() });
  // 链路追踪（结算 span；off = no-op 零开销）——停机时 shutdown 排空批处理器
  const otel = initOtel({
    serviceName: 'worker',
    mode: config.OTEL_TRACES_MODE,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  // Redis 必配（首选组件：ai 状态共享；连不上拒绝启动）
  const redis = createRedisClient(config.REDIS_URL, { serviceName: 'worker', ...process.env.REDIS_SENTINELS ? { sentinels: process.env.REDIS_SENTINELS, sentinelName: process.env.REDIS_SENTINEL_NAME, sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD } : {} });
  await assertRedisReachable(redis, 'worker', config.REDIS_URL);
  // 配置快照：关键业务参数生效值一处可查（排查「以为配了其实默认」类问题）
  console.log(
    `[worker] config snapshot: ${JSON.stringify({
      currency: config.WORKER_CURRENCY,
      settleIntervalMs: config.WORKER_SETTLE_INTERVAL_MS,
      referralIntervalMs: config.WORKER_REFERRAL_INTERVAL_MS,
      batchSize: config.WORKER_BATCH_SIZE,
      maxAttempts: config.WORKER_MAX_ATTEMPTS,
    })}`,
  );
  // 运营投影钩子（settlement 装配注入，事务外 best-effort）：
  //   onSettled → TPM actual 回填（成功请求的预占收尾 + 真实消耗记账）
  //             + balance_low 预警入箱（按用户×日幂等）
  //   onDead    → billing_dead 告警入箱
  const logger = {
    warn: (obj: unknown, msg: string) => console.warn('[worker]', msg, obj),
    error: (obj: unknown, msg: string) => console.error('[worker]', msg, obj),
    info: (obj: unknown, msg: string) => console.log('[worker]', msg, obj),
  };
  const notifyMailer =
    mailerFromEnv(config, { brand: 'AI Gateway 运维告警', brandEn: 'AI Gateway Ops Alerts', brandSub: 'AI GATEWAY · OPS' }) ?? undefined;
  const balanceLowThreshold = config.WORKER_BALANCE_LOW_THRESHOLD;
  const projectionLimiter = createSlidingWindowLimiter(redis, { failMode: 'open' });
  const settlement = createSettlementDomain({
    db,
    currency: config.WORKER_CURRENCY,
    policy: {
      maxAttempts: config.WORKER_MAX_ATTEMPTS,
      baseDelayMs: config.WORKER_BASE_DELAY_MS,
      maxDelayMs: config.WORKER_MAX_DELAY_MS,
    },
    onSettled: (data) => {
      const receipt = data.receipt as {
        apiKeyId?: number | null;
        channelId?: number | null;
        usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
      };
      const input = Math.max(0, receipt.usage?.inputTokens ?? 0);
      const cached = Math.min(Math.max(0, receipt.usage?.cachedInputTokens ?? 0), input);
      const tokens = input - cached + Math.max(0, receipt.usage?.outputTokens ?? 0);
      const dimensions = [
        receipt.apiKeyId != null ? `key:${receipt.apiKeyId}` : `user:${data.userId}`,
        ...(receipt.channelId != null ? [`channel:${receipt.channelId}`] : []),
      ];
      void projectionLimiter.backfillTpm(data.requestId, dimensions, tokens);
      // 余额预警（读结算后的钱包事实；入箱失败静默——告警不反噬结算）
      void repos.wallet
        .userAccountSummaries({ ...ctx, db }, data.userId)
        .then((rows) => {
          const account = rows.find((r) => r.kind === 'user');
          if (account && new Decimal(account.balance).lessThan(balanceLowThreshold)) {
            return db
              .insert(notifyOutbox)
              .values({
                event: 'balance_low',
                payload: { userId: data.userId, balance: account.balance, requestId: data.requestId },
                dedupeKey: `balance-low:${data.userId}:${new Date().toISOString().slice(0, 10)}`,
              })
              .onConflictDoNothing();
          }
        })
        .catch(() => undefined);
    },
    onDead: (data) => {
      // 补齐 userId（告警模板直读）
      void (async () => {
        const row = await db.$client
          .query<{ user_id: number }>('select user_id from billing_requests where request_id = $1', [data.requestId])
          .catch(() => null);
        await db
          .insert(notifyOutbox)
          .values({
            event: 'billing_dead',
            payload: {
              requestId: data.requestId,
              userId: row?.rows[0]?.user_id ?? null,
              failureClass: data.failureClass,
              attempt: data.attempt,
              lastError: data.lastError,
            },
            dedupeKey: `billing-dead:${data.requestId}`,
          })
          .onConflictDoNothing();
      })().catch(() => undefined);
    },
  });
  const runOnce = createRunOnce({
    settlement,
    ownerId: config.WORKER_OWNER_ID,
    batchSize: config.WORKER_BATCH_SIZE,
    claimLeaseMs: config.WORKER_CLAIM_LEASE_MS,
  });
  // 结算唤醒消费端（PG LISTEN/NOTIFY 门铃）：事件驱动即时结算 + 满批排空（积压一次抽干）；
  // 定时轮询缩为兜底。可配置关闭（纯轮询形态/测试隔离——多测试进程同队列会互相偷门铃）
  const settleWakeup = config.WORKER_SETTLE_WAKEUP
    ? createSettleWakeupConsumer(
        config.DATABASE_URL,
        async () => { await runOnce(ctx); },
        {
          logger: console as unknown as { error(obj: unknown, msg: string): void; info(obj: unknown, msg: string): void },
          batchSize: config.WORKER_BATCH_SIZE,
          pendingCount: async () => {
            const inv = await repos.billingRequest.inventory({ ...ctx, db }, new Date());
            return inv.pending + inv.retrying;
          },
        },
      )
    : null;
  // 生成任务轮询：终态信号（实扣/释放）走 billing 域；结算仍由 settlement 批次消费
  const billing = createBillingDomain({ db, currency: config.WORKER_CURRENCY });
  const pollGeneration = createGenerationPollUseCase({
    db,
    signal: (c, event) => billing.signal(c, event),
    taskPort: createTaskAdapter({
      encryptionKey: config.CHANNEL_API_KEY_ENCRYPTION,
      redis,
      // SSRF 双门：逃生门仅非生产可用（与 gateway 同口径）
      ...(config.WORKER_AI_ALLOW_LOCAL_URL && process.env.NODE_ENV !== 'production' ? { allowLocalUrl: true } : {}),
    }),
    config: {
      batch: config.WORKER_GENERATION_BATCH_SIZE,
      leaseMs: config.WORKER_GENERATION_LEASE_MS,
      expireReason: config.WORKER_GENERATION_EXPIRE_REASON,
    },
  });

  // 邀请佣金日结：独立 wallet 实例（refType 'referral' 白名单）；幂等在 wallet 自然键
  const referralWallet = createWallet({
    db,
    guards: {
      refTypes: ['referral'],
      currencies: [config.WORKER_CURRENCY],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: config.WORKER_CURRENCY,
  });

  let running = true;
  // 在途批次全量登记（四循环并发时单变量会互相覆盖——停机只等最后一批，旧的被杀在半路）
  const inFlight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>): Promise<unknown> => {
    inFlight.add(p);
    void p.catch(() => undefined).then(() => inFlight.delete(p));
    return p;
  };
  const loop = (intervalMs: number, job: () => Promise<unknown>, name: string) => {
    const tick = async () => {
      if (!running) return;
      try {
        await track(Promise.resolve(job()));
      } catch (error) {
        console.error(`[worker] ${name} loop failed:`, error);
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return timer;
  };

  const timers = [
    loop(config.WORKER_SETTLE_INTERVAL_MS, () => runOnce(ctx), 'settle'),
    loop(
      config.WORKER_RECOVER_INTERVAL_MS,
      () => settlement.recover(ctx, { batchSize: config.WORKER_RECOVERY_BATCH_SIZE }),
      'recover',
    ),
    loop(config.WORKER_GENERATION_INTERVAL_MS, () => pollGeneration(ctx), 'generation'),
    loop(
      config.WORKER_REFERRAL_INTERVAL_MS,
      () =>
        runReferralCommissionOnce({
          db,
          wallet: referralWallet,
          // 营销参数存 DB：每 tick 读现值——管理面改比例下一轮生效
          commissionRate: async () => (await repos.marketing.getSettings({ db, ...ctx })).referralCommissionRate,
          ctx,
        }),
      'referral',
    ),
    // ---- 告警 / 对账 / 分区维护循环 ----
    // 告警投递：notify_outbox 消费者（缺位 = channel_disabled/billing_dead/…全静默）；
    // WORKER_NOTIFY_ENABLED=false 静音（dev 测试噪音不打扰真实渠道——事件仍入箱可查）
    ...(config.WORKER_NOTIFY_ENABLED ? [loop(
      config.WORKER_NOTIFY_INTERVAL_MS,
      () =>
        runNotifyDispatchOnce(db, logger, notifyMailer, {
          encryptionKey: config.CHANNEL_API_KEY_ENCRYPTION,
          ownerId: config.WORKER_OWNER_ID,
          claimLeaseMs: config.WORKER_NOTIFY_CLAIM_LEASE_MS,
          // SSRF 双门（与 AI 上游同口径）：env 允许且非生产才放行回环/私网 webhook
          ...(config.WORKER_WEBHOOK_ALLOW_LOCAL_URL && process.env.NODE_ENV !== 'production'
            ? { webhookAllowLocalUrl: true }
            : {}),
        }),
      'notify',
    )] : []),
    // 周期对账哨兵：wallet 复式不变量（资损最后防线）
    loop(config.WORKER_RECONCILE_INTERVAL_MS, () => runReconcileOnce(db, logger), 'reconcile'),
    // 分区维护：trace_spans / request_logs（缺位 = 窗口过后插入失败）
    loop(
      config.WORKER_PARTITION_INTERVAL_MS,
      () => runTracePartitionMaintenance(db, { retentionDays: config.TRACE_RETENTION_DAYS }, logger),
      'trace-partitions',
    ),
    loop(
      config.WORKER_PARTITION_INTERVAL_MS,
      () =>
        runRequestLogPartitionMaintenance(db, { retentionDays: config.REQUEST_LOG_RETENTION_DAYS }, logger),
      'request-log-partitions',
    ),
  ];

  // 健康端点（compose healthcheck：livez/readyz 开放；/health 深度报告令牌保护）。
  // 0 = 关闭（测试隔离）；端口占用只告警不崩主进程（健康面是辅助，结算才是主业）
  const healthServer =
    config.WORKER_HEALTH_PORT > 0
      ? startHealthServer(
          config.WORKER_HEALTH_PORT,
          {
            live: () => running,
            ready: () => running,
            deep: () => ({ owner: config.WORKER_OWNER_ID, running }),
          },
          config.WORKER_HEALTH_TOKEN,
        )
      : null;
  healthServer?.on('error', (error: Error) => {
    console.error(`[worker] health server error (port=${config.WORKER_HEALTH_PORT}):`, error.message);
  });
  healthServer?.unref?.();

  return {
    hasWakeConsumer: () => settleWakeup != null,
    async stop() {
      const idx = liveWorkerInstances.findIndex((i) => i.owner === config.WORKER_OWNER_ID);
      if (idx >= 0) liveWorkerInstances.splice(idx, 1);
      running = false; // 拒新批次
      for (const timer of timers) clearInterval(timer);
      // 全部在途批次完成（宽限上界内）；账务安全网：认领租约到期由他副本/下轮 recover 接管
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => setTimeout(resolve, config.WORKER_SHUTDOWN_GRACE_MS).unref()),
      ]);
      // 优雅停机：本副本仍持有的 processing 认领立即归还 retry_wait（不等 60s 租约自然到期）
      await repos.billingRequest
        .abandonOwnedClaims({ ...ctx, db }, config.WORKER_OWNER_ID, new Date())
        .catch(() => undefined);
      if (healthServer) await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      await settleWakeup?.close().catch(() => undefined);
      await otel.shutdown().catch(() => {});
      await redis?.quit().catch(() => {});
      await db.$client.end().catch(() => {});
    },
  };
}

// 自启动守卫：NODE_ENV 在某些测试运行器形态下不设 'test'（实测全局 vitest 4.1.1），
// 模块被测试动态导入即幽灵自启——加显式退出开关（测试导入方 opt-out）
const autostartDisabled = process.env.WORKER_NO_AUTOSTART === '1' || process.env.VITEST === 'true';
if (process.env.NODE_ENV !== 'test' && !autostartDisabled) {
  const handles = await startWorker(loadConfig());
  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} received, stopping`);
    void handles.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref(); // 强退兜底
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log('[worker] started');
}
