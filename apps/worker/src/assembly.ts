/**
 * worker 唯一装配根（非 assembly 代码只持闭包与纯契约——Db/composition
 * 子入口只在本文件出现）。装配分七段：观测/db → billing（两套 wallet 实例 +
 * settlement + signal 桥）→ notifications（outbox 桥 + SMTP）→ inference
 * poll（signal/渠道桥）→ 佣金（rate/refId 桥——词表单一真相在 accounts）→
 * 对账（会话锁门）→ jobs/wakeup 注册。
 * 桥接说明：inference 蛇形信号词表 ↔ billing 点分词表的映射与 gateway
 * billing-port 同款（apps 互不依赖，共享真相是两包的类型本身）。
 */
/* eslint-disable max-lines -- 装配根 composition root：线性依赖组装，行数棘轮与
   下方 max-lines-per-function 同口径（拆段/拆文件只会层层透传上下文） */
import { createTransport } from 'nodemailer';
import { assertSafeAddress, assertSafeUrl, createAi } from '@tillgate/ai';
import type { Ai } from '@tillgate/ai';
import { createCipher, createLogger } from '@tillgate/runtime';
import type { Logger } from '@tillgate/runtime';
import { closeDb, createDb, ping, withSessionTryLock } from '@tillgate/db';
import type { Db, DbTx, LockDefectHook } from '@tillgate/db';
import { initOtel, createObservability } from '@tillgate/observability';
// writeAudit = 跨能力审计桥原语（仅 assembly 可引用 composition 子入口）
import { writeAudit } from '@tillgate/observability/composition';
import type { OtelHandle } from '@tillgate/observability';
import {
  Decimal,
  SETTLE_WAKE_CHANNEL,
  createBillingApi,
  createDefaultFundingRegistry,
  createRecordDiscrepanciesUseCase,
  createReferralCommissionUseCase,
  createSettlementApi,
  createWalletApi,
} from '@tillgate/billing';
import type {
  NotificationOutboxPort,
  OutboxFact,
  ReconcileReport,
  SettlementApi,
} from '@tillgate/billing';
import {
  createPostgresBillingStore,
  createPostgresCommissionStatsStore,
  createPostgresReconcileDiscrepancyStore,
  createPostgresWalletStore,
} from '@tillgate/billing/composition';
import { readPlatformCurrency } from '@tillgate/billing/composition';
import { createNotifications, systemContext } from '@tillgate/notifications';
import type { EmailSender, Notifications } from '@tillgate/notifications';
import { outboxWithinTx } from '@tillgate/notifications/composition';
import { commissionRefId } from '@tillgate/accounts';
import { createPostgresAccountStore } from '@tillgate/accounts/composition';
import {
  postgresChannelStore,
  createPostgresIntegrationSettingsReader,
} from '@tillgate/control-plane/composition';
import {
  createGenerationPollUseCase,
  createPostgresGenerationTaskStore,
  createUpstreamAi,
} from '@tillgate/inference';
import { toBillingEvent, toChannelCandidate } from './bridge-mappers.js';
import type { WorkerConfig } from './config';
import { createScheduler } from './scheduler';
import type { Scheduler } from './scheduler';
import { createNotifyJob } from './jobs/notify';
import { createPartitionJob } from './jobs/partition';
import { createPollJob } from './jobs/poll';
import { createReconcileJob } from './jobs/reconcile';
import { createReferralJob } from './jobs/referral';
import { createRecoveryJob } from './jobs/recovery';
import { createSettlementDispatch } from './queue/settlement-dispatch';
import type { createSettlementQueue } from './queue/settlement-queue';
import { createSettleWakeListener } from './wakeup/postgres-notify';
import type { SettleWakeListener } from './wakeup/postgres-notify';
import type { WorkerHealthState } from './health';

/** 事务重试策略（与 billing 组装件同值） */
const TX_RETRY = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 } as const;
/** 对账会话锁键（重叠部署互斥，与分区锁同口径） */
const RECONCILE_LOCK_KEY = 'ai-gateway:billing-reconcile';
/** settlement 侧 wallet guards（默认 wallet 全词表口径;币种自平台 KV 派生） */
const settlementGuardsOf = (platformCurrency: string) =>
  ({
    refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack', 'redeem'],
    currencies: [platformCurrency],
    internalAccounts: ['outside', 'platform_revenue'],
  }) as const;
/** 佣金侧 wallet guards（独立佣金钱包口径：只许 referral 资金流） */
const referralGuardsOf = (platformCurrency: string) =>
  ({
    refTypes: ['referral'],
    currencies: [platformCurrency],
    internalAccounts: ['outside', 'platform_revenue'],
  }) as const;

/** 装配时钟（模块级纯函数——不捕获闭包；测试经 job 用例注入各自时钟） */
const workerClock = (): Date => new Date();

/**
 * 每 scheduler tick 的 DB 连接需求记账（红队复审 R-2）：partitions/reconcile
 * 持会话锁专用连接 + 工作连接（各 2 条）；其余 tick 1 条。新 tick 默认记 1，
 * 持锁/双连接形态必须在此显式声明——本表是 runner 注册表的伴随事实。
 */
const TICK_CONN_DEMAND: Readonly<Record<string, number>> = { partitions: 2, reconcile: 2 };
/** 探针/唤醒入队等非 tick 需求的余量 */
const TICK_MARGIN = 2;

/**
 * 池-并发不变量：从 runner 注册表派生（单一真相，禁手工计数——notify 开关、
 * 新 job 注册都会使抄写数字漂移）。worker 无预算门，DB 并发被结构性钳死的
 * 前提是池 ≥ 最大并发；不满足 = 检出排队起点，node 塌吞吐 / Bun SQL 楔死
 * （F-6）——fail-fast 胜过带病运行。
 */
function assertPoolCoversConcurrency(config: WorkerConfig, ticks: readonly string[]): void {
  const tickDemand = ticks.reduce((sum, name) => sum + (TICK_CONN_DEMAND[name] ?? 1), 0);
  const worstCase = config.settle.bullmq.concurrency + tickDemand + TICK_MARGIN;
  if (config.dbPool.poolMax < worstCase) {
    throw new Error(
      `worker DB pool ${config.dbPool.poolMax} < worst-case DB concurrency ${worstCase} ` +
        `(settle concurrency ${config.settle.bullmq.concurrency} + ${ticks.length} ticks ` +
        `(${tickDemand} conns incl. lock-held double-connection ticks) + ${TICK_MARGIN} margin); ` +
        'pool checkout queueing wedges/stalls under load — raise poolMax or lower concurrency',
    );
  }
}

export interface WorkerAssembly {
  logger: Logger;
  otel: OtelHandle;
  db: Db;
  closeDb: () => Promise<void>;
  pingDb: () => Promise<void>;
  scheduler: Scheduler;
  healthState: WorkerHealthState;
  /** null = WORKER_SETTLE_WAKE=false（未挂 LISTEN 消费端） */
  wakeup: SettleWakeListener | null;
  /** BullMQ 结算队列（消费端随装配启动；停机收口用） */
  settleQueue: ReturnType<typeof createSettlementQueue>;
  /** 停机收口：本副本 processing 认领立即归还 retry_wait（不等租约到期） */
  abandonOwnedClaims: () => Promise<number>;
  jobs: readonly string[];
  /** job 名 → 驱动入口（E2E/运维探测直接驱动，不经定时器） */
  runners: Readonly<Record<string, () => Promise<unknown>>>;
}

/** inference 蛇形 → billing 点分 与 渠道行 → 候选形状两个桥接映射已拆至 ./bridge-mappers.ts */

// eslint-disable-next-line max-lines-per-function, max-statements -- 装配根 composition root:线性依赖组装,每条语句即一个装配步骤;拆段只会层层透传上下文
/** 装配引导覆写（生产缺省不传=读 KV;单测注入以保零连接前提） */
export interface WorkerAssemblyBootstrap {
  readonly platformCurrency?: string;
}

// eslint-disable-next-line max-lines-per-function, max-statements -- 装配根 composition root:线性依赖组装,每条语句即一个装配步骤;拆段只会层层透传上下文
export async function assembleWorker(
  config: WorkerConfig,
  bootstrap: WorkerAssemblyBootstrap = {},
): Promise<WorkerAssembly> {
  const logger = createLogger({
    level: config.logLevel,
    serviceName: 'worker',
    pretty: config.nodeEnv !== 'production',
  });
  const db = createDb({ url: config.databaseUrl, ...config.dbPool });
  // 平台币种启动读（写一次 KV;替代硬编码 CNY——单一真相;测试可覆写）
  const platformCurrency = bootstrap.platformCurrency ?? (await readPlatformCurrency(db));
  const otel = initOtel({
    serviceName: 'worker',
    serviceVersion: config.serviceVersion,
    mode: config.otelMode,
    ...(config.otelEndpoint != null ? { endpoint: config.otelEndpoint } : {}),
    ...(config.otelAuthToken != null ? { authToken: config.otelAuthToken } : {}),
    ...(config.otelMode === 'otlp'
      ? { metricsExportIntervalMs: config.otelMetricsIntervalMs }
      : {}),
    logger,
  });
  const clock = workerClock;
  const onError = (error: unknown, context: string): void => {
    logger.error({ err: String(error), context }, 'worker dependency error');
  };

  // ---- billing：store + 两套 wallet + settlement/signal ----
  const walletStore = createPostgresWalletStore(db, { retry: TX_RETRY });
  const billingStore = createPostgresBillingStore(db, { retry: TX_RETRY });
  const settlementWallet = createWalletApi({
    store: walletStore,
    guards: settlementGuardsOf(platformCurrency),
    currency: config.currency,
  });
  const referralWallet = createWalletApi({
    store: walletStore,
    guards: referralGuardsOf(platformCurrency),
    currency: config.currency,
  });
  const fundingRegistry = createDefaultFundingRegistry({
    wallet: settlementWallet,
    walletStore,
    store: billingStore,
    quota: billingStore.quotaStore,
  });

  // ---- notifications：facade + billing 同事务入箱桥 ----
  const cipher = createCipher(config.encryptionKey);
  // 告警邮件动态化：每次投递严格读快照（fail-loud），
  // SMTP 未生效抛错走投递失败重试路径（email 渠道 fail-closed 语义等价）；
  // 传输器随配置指纹重建。密钥 = 对称加密根键 ENCRYPTION_KEY
  // （渠道 Key 与 integration settings 跨进程共用同一根键，与 admin-api 加密侧一致）。
  const integrationReader = createPostgresIntegrationSettingsReader({
    db,
    cipher,
    onError: (error: unknown) =>
      logger.warn({ err: error }, 'integration settings background refresh failed'),
  });
  let mailFingerprint = '';
  let mailTransporter: ReturnType<typeof createTransport> | null = null;
  const emailSender: EmailSender = {
    send: async (to, subject, text) => {
      const snapshot = await integrationReader.resolve();
      const smtp = snapshot.smtp.config;
      if (smtp == null || !snapshot.smtp.effective) {
        throw new Error('smtp integration not effective');
      }
      const next = `${smtp.host}|${smtp.port}|${smtp.user}|${smtp.pass}`;
      if (next !== mailFingerprint || mailTransporter == null) {
        mailTransporter = createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.pass },
        });
        mailFingerprint = next;
      }
      await mailTransporter.sendMail({ from: smtp.from, to, subject, text });
    },
  };
  const notifications: Notifications = createNotifications({
    db,
    cipher,
    urlGuard: {
      assert: (url, opts) => assertSafeUrl(url, { allowLocal: opts.allowLocal }),
      assertAddress: (address, opts) => assertSafeAddress(address, { allowLocal: opts.allowLocal }),
    },
    emailSender,
    logger: { warn: (obj, msg) => logger.warn(obj, msg) },
    webhookAllowLocalUrl: config.webhookAllowLocalUrl,
    config: config.notify.dispatch,
  });
  const notifyCtx = systemContext(config.ownerId);
  /** billing 结算/死信事实同事务入箱（入箱失败回滚业务事务） */
  const outboxPort: NotificationOutboxPort = {
    append: async (tx, fact: OutboxFact) => {
      // 句柄两包同底（同一 DbTx 的 opaque 铸形）；enqueue 的 onConflictDoNothing
      // 即 append 契约的「dedupe 幂等吸收」——返回值无消费方（billing 侧忽略）
      await outboxWithinTx(tx as unknown as DbTx).enqueue(fact);
      return true;
    },
  };

  // balance_low 预警：结算后查用户余额，低于阈值入箱
  // （按用户×日幂等；全程 catch 静默——告警不反噬结算）
  const balanceLowCheck = async (data: { requestId: string; userId: number }): Promise<void> => {
    const accounts = await settlementWallet.accounts(data.userId);
    const dayKey = clock().toISOString().slice(0, 10).replace(/-/g, '');
    for (const account of accounts) {
      if (account.kind !== 'user') continue;
      if (new Decimal(account.balance).lessThan(config.balanceLowThreshold)) {
        await notifications.enqueue({
          event: 'balance_low',
          payload: { userId: data.userId, balance: account.balance, requestId: data.requestId },
          dedupeKey: `balance-low:${data.userId}:${dayKey}`,
        });
      }
    }
  };

  const settlement: SettlementApi = createSettlementApi({
    store: billingStore,
    walletStore,
    fundingRegistry,
    channels: billingStore.channelStore,
    usageDefectBreaker: config.usageDefectBreaker,
    failurePolicy: config.settle.failurePolicy,
    clock,
    onError,
    outbox: outboxPort,
    onSettled: (data) => {
      void balanceLowCheck(data).catch(() => {});
    },
    onUsageDefect: (data) => {
      logger.error({ ...data }, 'usage evidence violation — invoice clamped');
      // 与网关同款 best-effort 审计（两结算进程都要留痕——谁结算谁落账）
      writeAudit(db, {
        actor: 'system',
        adminId: null,
        action: 'billing.usage_evidence_violation',
        targetType: 'channel',
        targetId: String(data.channelId ?? ''),
        detail: {
          requestId: data.requestId,
          clamps: data.clamps as unknown as Record<string, unknown>,
          defects: data.defects,
          broken: data.broken,
        },
      }).catch(() => {});
    },
  });

  // signal 面（生成任务终态信号桥）：authorize 在 worker 结构性不可达——
  // 哨兵 resolver 即刻显式失败（gateway 侧桥持有真实实现）
  const billingApi = createBillingApi({
    store: billingStore,
    resolver: {
      resolve: async () => {
        throw new Error('worker assembly does not authorize (gateway face owns resolver)');
      },
    },
    quota: billingStore.quotaStore,
    channels: billingStore.channelStore,
    walletStore,
    wallet: settlementWallet,
    currency: config.currency,
    clock,
  });

  // ---- inference：生成任务轮询（signal/渠道/状态三桥）----
  const ai: Ai = createAi(
    {},
    // SSRF 双门：逃生门仅非生产可用。
    // 防线 = 机械基线 + 运营面信任（渠道/provider 写入是 admin 域）
    config.aiAllowLocalUrl && config.nodeEnv !== 'production'
      ? { guardUrl: async () => {} }
      : {
          guardUrl: async (url: string) => {
            await assertSafeUrl(url);
          },
        },
  );
  const pollGeneration = createGenerationPollUseCase({
    tasks: createPostgresGenerationTaskStore(db),
    upstream: createUpstreamAi({ ai, decrypt: (enc) => cipher.decrypt(enc) }),
    signal: async (input) => {
      await billingApi.signal(toBillingEvent(input));
    },
    billingStatus: (requestId) => settlement.currentStatus(requestId),
    findChannel: async (task) => {
      const row = await postgresChannelStore.findTaskChannel(db, task.channelId);
      // 出站名用任务行提交时快照（在途任务不随绑定改名漂移）
      return row == null ? null : toChannelCandidate(row, task.upstreamModel);
    },
    config: {
      batch: config.generation.batchSize,
      leaseMs: config.generation.leaseMs,
      expireReason: config.generation.expireReason,
      executeDeadlineMs: config.generation.executeDeadlineMs,
      executeMaxRetries: config.generation.executeMaxRetries,
    },
    onError: (error, context) =>
      logger.error({ err: String(error), context }, 'generation poll error'),
  });

  // ---- 佣金日结：rate/refId 桥（词表单一真相在 accounts domain）----
  const accountStore = createPostgresAccountStore();
  const runReferralCommission = createReferralCommissionUseCase({
    stats: createPostgresCommissionStatsStore(db),
    wallet: referralWallet,
    rate: async () => (await accountStore.getMarketingSettings(db)).referralCommissionRate,
    refIdOf: (inviterId, utcDayKey) => commissionRefId(inviterId, utcDayKey),
    backfillDays: config.referral.backfillDays,
    clock,
    onError: (error, context) =>
      logger.error({ err: String(error), context }, 'referral commission error'),
  });

  // ---- 对账：差异落表 + 会话锁门（专用连接 try-lock）----
  const recordDiscrepancies = createRecordDiscrepanciesUseCase({
    store: createPostgresReconcileDiscrepancyStore(db),
  });
  /** 解锁失败缺陷上报(R-5):连接已销毁(锁随连接释放),缺陷可见性走 error 日志 */
  const lockDefect: LockDefectHook = (error, key) => {
    logger.error({ err: String(error), key }, 'advisory unlock failed; lock connection destroyed');
  };
  const withTryLock = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> =>
    withSessionTryLock(db, { key, onDefect: lockDefect }, fn);
  const runReconcile = createReconcileJob({
    settlement,
    lockKey: RECONCILE_LOCK_KEY,
    withTryLock,
    recordDiscrepancies: (report: ReconcileReport) => recordDiscrepancies(report),
    enqueueAlert: async ({ discrepancies, dedupeKey }) => {
      await notifications.enqueue({
        event: 'reconcile_discrepancy',
        payload: { discrepancies },
        dedupeKey,
      });
    },
    clock,
    logger,
  });

  // ---- 分区维护 + jobs 注册 ----
  const observability = createObservability({ db });
  const runPartitions = createPartitionJob({
    partitions: observability.partitions,
    traceRetentionDays: config.partition.traceRetentionDays,
    requestLogRetentionDays: config.partition.requestLogRetentionDays,
    logger,
  });
  // ---- BullMQ 结算调度(2026-08-26 增量):processor=处理面唯一真相,queue=触发/隔离面 ----
  const settlementDispatch = createSettlementDispatch({
    settlement,
    config: {
      ownerId: config.ownerId,
      batchSize: config.settle.batchSize,
      settleBatchSize: config.settle.settleBatchSize,
      claimLeaseMs: config.settle.claimLeaseMs,
      backoffBaseMs: config.settle.failurePolicy.baseDelayMs,
      bullmq: config.settle.bullmq,
    },
    onError,
    logger,
  });
  const settleQueue = settlementDispatch.queue;
  const runSettlementSweep = settlementDispatch.sweep;
  const runSettlementDirect = settlementDispatch.direct;
  const scheduler = createScheduler({
    graceMs: config.shutdownGraceMs,
    onError: (error, name) => logger.error({ err: String(error), job: name }, 'job tick failed'),
    now: clock,
  });
  /** job 名 → 驱动入口（E2E/运维探测直接驱动；调度循环只是节奏包装） */
  const runners: Record<string, () => Promise<unknown>> = {
    settle: runSettlementDirect,
    recover: createRecoveryJob({ settlement, batchSize: config.recover.batchSize }),
    generation: createPollJob({ poll: pollGeneration }),
    referral: createReferralJob({ run: runReferralCommission }),
    reconcile: runReconcile,
    partitions: runPartitions,
    ...(config.notify.enabled
      ? {
          notify: createNotifyJob({
            dispatchOnce: () =>
              notifications.dispatchOnce({ ctx: notifyCtx, ownerId: `notify-${config.ownerId}` }),
          }),
        }
      : {}),
  };
  const intervals: Record<string, number> = {
    settle: config.settle.intervalMs,
    recover: config.recover.intervalMs,
    generation: config.generation.intervalMs,
    referral: config.referral.intervalMs,
    reconcile: config.reconcile.intervalMs,
    partitions: config.partition.intervalMs,
    ...(config.notify.enabled ? { notify: config.notify.intervalMs } : {}),
  };
  // settle 的调度 tick = sweep 入队(处理面在 BullMQ worker);其余 job tick=runner 本体
  const schedulerTicks: Record<string, () => Promise<unknown>> = {
    ...runners,
    settle: runSettlementSweep,
  };
  // 池不变量断言在注册表既成事实之后（派生计数,装配即锁）
  assertPoolCoversConcurrency(config, Object.keys(schedulerTicks));
  for (const [name, run] of Object.entries(schedulerTicks)) {
    // runner 与 interval 表装配期同源声明;缺间隔即装配缺陷,fail-fast 胜过注册 undefined 周期
    const intervalMs = intervals[name];
    if (intervalMs === undefined) {
      throw new Error(`worker runner "${name}" has no interval configured`);
    }
    scheduler.register({ name, intervalMs, run });
  }

  // ---- 唤醒消费端（LISTEN 专用连接；收口挂 shutdown closeables）----
  const wakeup = config.settle.wake
    ? createSettleWakeListener({
        listen: (channel, onMessage) => db.$client.listen(channel, onMessage),
        channel: SETTLE_WAKE_CHANNEL,
        onWake: async (requestId) => {
          if (requestId != null) {
            await settleQueue.enqueueMany([requestId]);
          } else {
            await runSettlementSweep();
          }
        },
        logger,
      })
    : null;

  const healthState: WorkerHealthState = {
    live: () => scheduler.isRunning(),
    // readyz 三探测（scheduler + PG + BullMQ Redis）：未启动短路
    // （不触依赖），探测失败 = 不就绪（fail-closed，warn 留痕——依赖侧日志不覆盖 ping 拒绝）。
    ready: async () => {
      if (!scheduler.isRunning()) return false;
      try {
        await ping(db);
        await settleQueue.ping();
        return true;
      } catch (error) {
        logger.warn({ err: String(error) }, 'worker readiness probe failed');
        return false;
      }
    },
    deep: () => ({
      owner: config.ownerId,
      running: scheduler.isRunning(),
      jobs: scheduler.snapshots(),
    }),
  };

  return {
    logger,
    otel,
    db,
    closeDb: () => closeDb(db),
    pingDb: () => ping(db),
    scheduler,
    healthState,
    wakeup,
    settleQueue,
    abandonOwnedClaims: () => settlement.abandonOwnedClaims(config.ownerId),
    jobs: Object.keys(scheduler.snapshots()),
    runners,
  };
}
