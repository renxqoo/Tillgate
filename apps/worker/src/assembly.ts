/**
 * worker 唯一装配根（P5：非 assembly 代码只持闭包与纯契约——Db/composition
 * 子入口只在本文件出现）。装配分七段：观测/db → billing（两套 wallet 实例 +
 * settlement + signal 桥）→ notifications（outbox 桥 + SMTP）→ inference
 * poll（signal/渠道桥）→ 佣金（rate/refId 桥——词表单一真相在 accounts）→
 * 对账（会话锁门）→ jobs/wakeup 注册。
 * 桥接说明：inference 蛇形信号词表 ↔ billing 点分词表的映射与 gateway
 * billing-port 同款（apps 互不依赖，共享真相是两包的类型本身）。
 */
import { createTransport } from 'nodemailer';
import { assertSafeUrl, createAi } from '@tillgate/ai';
import type { Ai } from '@tillgate/ai';
import { createCipher, createLogger } from '@tillgate/runtime';
import type { Logger } from '@tillgate/runtime';
import { closeDb, createDb, ping } from '@tillgate/db';
import type { Db, DbTx } from '@tillgate/db';
import { initOtel, createObservability } from '@tillgate/observability';
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
import { createRecoveryJob, createSettlementBatchJob } from './jobs/settlement';
import { createSettleWakeListener } from './wakeup/postgres-notify';
import type { SettleWakeListener } from './wakeup/postgres-notify';
import type { WorkerHealthState } from './health';

/** v1 等价重试策略（billing 组装件沿用值） */
const TX_RETRY = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 } as const;
/** 对账会话锁键（保留 v1 键——重叠部署互斥，与分区锁同口径） */
const RECONCILE_LOCK_KEY = 'ai-gateway:billing-reconcile';
/** settlement 侧 wallet guards（v1 默认 wallet 全词表口径） */
const SETTLEMENT_GUARDS = {
  refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack', 'redeem'],
  currencies: ['CNY'],
  internalAccounts: ['outside', 'platform_revenue'],
} as const;
/** 佣金侧 wallet guards（v1 独立佣金钱包口径：只许 referral 资金流） */
const REFERRAL_GUARDS = {
  refTypes: ['referral'],
  currencies: ['CNY'],
  internalAccounts: ['outside', 'platform_revenue'],
} as const;

/** 装配时钟（模块级纯函数——不捕获闭包；测试经 job 用例注入各自时钟） */
const workerClock = (): Date => new Date();

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
  /** 停机收口：本副本 processing 认领立即归还 retry_wait（不等租约到期） */
  abandonOwnedClaims: () => Promise<number>;
  jobs: readonly string[];
  /** job 名 → 驱动入口（E2E/运维探测直接驱动，不经定时器） */
  runners: Readonly<Record<string, () => Promise<unknown>>>;
}

/** inference 蛇形 → billing 点分 与 渠道行 → 候选形状两个桥接映射已拆至 ./bridge-mappers.ts */

// eslint-disable-next-line max-lines-per-function, max-statements -- 装配根 composition root:线性依赖组装,每条语句即一个装配步骤;拆段只会层层透传上下文(存量棘轮)
export function assembleWorker(config: WorkerConfig): WorkerAssembly {
  const logger = createLogger({
    level: config.logLevel,
    serviceName: 'worker',
    pretty: config.nodeEnv !== 'production',
  });
  const db = createDb({ url: config.databaseUrl, ...config.dbPool });
  const otel = initOtel({
    serviceName: 'worker',
    serviceVersion: config.serviceVersion,
    mode: config.otelMode,
    ...(config.otelEndpoint != null ? { endpoint: config.otelEndpoint } : {}),
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
    guards: SETTLEMENT_GUARDS,
    currency: config.currency,
  });
  const referralWallet = createWalletApi({
    store: walletStore,
    guards: REFERRAL_GUARDS,
    currency: config.currency,
  });
  const fundingRegistry = createDefaultFundingRegistry({
    wallet: settlementWallet,
    walletStore,
    store: billingStore,
    quota: billingStore.quotaStore,
  });

  // ---- notifications：facade + billing 同事务入箱桥 ----
  const cipher = createCipher(config.channelApiKeyEncryption);
  // 告警邮件动态化（DESIGN §5 D7）：每次投递严格读快照（fail-loud），
  // SMTP 未生效抛错走投递失败重试路径（email 渠道 fail-closed 语义等价）；
  // 传输器随配置指纹重建。密钥 = 渠道 Key 同一部署契约（CHANNEL_API_KEY_ENCRYPTION）。
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
    urlGuard: { assert: (url, opts) => assertSafeUrl(url, { allowLocal: opts.allowLocal }) },
    emailSender,
    logger: { warn: (obj, msg) => logger.warn(obj, msg) },
    webhookAllowLocalUrl: config.webhookAllowLocalUrl,
    config: config.notify.dispatch,
  });
  const notifyCtx = systemContext(config.ownerId);
  /** billing 结算/死信事实同事务入箱（§5.4：入箱失败回滚业务事务） */
  const outboxPort: NotificationOutboxPort = {
    append: async (tx, fact: OutboxFact) => {
      // 句柄两包同底（同一 DbTx 的 opaque 铸形）；enqueue 的 onConflictDoNothing
      // 即 append 契约的「dedupe 幂等吸收」——返回值无消费方（billing 侧忽略）
      await outboxWithinTx(tx as unknown as DbTx).enqueue(fact);
      return true;
    },
  };

  // balance_low 预警（v1 onSettled 钩子对位）：结算后查用户余额，低于阈值入箱
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
    failurePolicy: config.settle.failurePolicy,
    clock,
    onError,
    outbox: outboxPort,
    onSettled: (data) => {
      void balanceLowCheck(data).catch(() => {});
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
    // SSRF 双门：逃生门仅非生产可用（v1 同口径）。
    // 生产主防线 = 受信 provider host 白名单（生产必填，config fail-fast）+ DNS 逐地址判定
    config.aiAllowLocalUrl && config.nodeEnv !== 'production'
      ? { guardUrl: async () => {} }
      : {
          guardUrl: async (url: string) => {
            await assertSafeUrl(url, { allowedHosts: config.upstreamAllowedHosts });
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
    findChannel: async (channelId) => {
      const row = await postgresChannelStore.findTaskChannel(db, channelId);
      return row == null ? null : toChannelCandidate(row);
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
  const withTryLock = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    const client = await db.$client.connect();
    try {
      const locked = await client.query<{ locked: boolean }>({
        text: 'select pg_try_advisory_lock(hashtext($1)) as locked',
        values: [key],
      });
      if (locked.rows[0]?.locked !== true) return null;
      try {
        return await fn();
      } finally {
        await client.query({ text: 'select pg_advisory_unlock(hashtext($1))', values: [key] });
      }
    } finally {
      client.release();
    }
  };
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
  const runSettlementBatch = createSettlementBatchJob({
    settlement,
    ownerId: config.ownerId,
    batchSize: config.settle.batchSize,
    claimLeaseMs: config.settle.claimLeaseMs,
  });
  const scheduler = createScheduler({
    graceMs: config.shutdownGraceMs,
    onError: (error, name) => logger.error({ err: String(error), job: name }, 'job tick failed'),
    now: clock,
  });
  /** job 名 → 驱动入口（E2E/运维探测直接驱动；调度循环只是节奏包装） */
  const runners: Record<string, () => Promise<unknown>> = {
    settle: runSettlementBatch,
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
  for (const [name, run] of Object.entries(runners)) {
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
        connect: async () => await db.$client.connect(),
        channel: SETTLE_WAKE_CHANNEL,
        runBatch: async () => (await runSettlementBatch()).claimed,
        batchSize: config.settle.batchSize,
        logger,
      })
    : null;

  const healthState: WorkerHealthState = {
    live: () => scheduler.isRunning(),
    ready: () => scheduler.isRunning(),
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
    abandonOwnedClaims: () => settlement.abandonOwnedClaims(config.ownerId),
    jobs: Object.keys(scheduler.snapshots()),
    runners,
  };
}
