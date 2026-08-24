/**
 * 装配根：进程级依赖一次组装（db / Redis / billing / inference / 控制面读 / 限流 /
 * 爆破防护 / OTel / 请求日志），请求级上下文由中间件派生。全部可变值来自 config
 * ——本文件零字面量配置（缺省属 config 层）。
 * composition 子入口仅本文件与 src/adapters/* 引用（§5.3 白名单 + 架构测试）。
 */
import { closeDb, createDb, ping } from '@tillgate/db';
import {
  createLogger,
  createRedisClient,
  createSlidingWindowLimiter,
  createKeyBruteForceGuard,
  createAuthFailureGuard,
  createCipher,
} from '@tillgate/runtime';
import {
  createBilling,
  createPostgresBillingStore,
  createPostgresWalletStore,
} from '@tillgate/billing/composition';
import { createBillingAdmission, type Billing } from '@tillgate/billing';
import { createPgFundingSourceResolver } from '@tillgate/accounts/composition';
import { createAccounts, type AccountUseCases, type WalletCreditPort } from '@tillgate/accounts';
import { type SessionInvalidationPort } from '@tillgate/accounts/composition';
import { postgresModelStore } from '@tillgate/control-plane/composition';
import type { EnabledModelRow } from '@tillgate/control-plane';
import { initOtel } from '@tillgate/observability';
import { createPgRequestLogStore } from '@tillgate/observability/composition';
import { assertSafeUrl, createAi } from '@tillgate/ai';
import {
  createInference,
  createRedisHealthStore,
  createPostgresGenerationTaskStore,
  type Inference,
} from '@tillgate/inference';
import { createPostgresGatewayCatalog } from './adapters/catalog-port';
import { createGatewayBilling } from './adapters/billing-port';
import { createSettleWakeProducer } from './adapters/settle-wake';
import { otelTracePort } from './adapters/trace-port';
import { tryChannelRpm, type RateLimitGate } from './http/middleware/rate-limit';
import { ACCOUNTS_POLICY, BILLING_GUARDS, type GatewayConfig } from './config';

/** 渠道健康 Redis 键前缀（inference B11 机器级前缀纪律：breaker/credential 分键） */
const HEALTH_PREFIX = 'inference:health:';

/** v1 等价重试策略（db 包 transaction 注释口径；生产缺省归 app config） */
const TX_RETRY = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 } as const;

export interface GatewayAssembly {
  db: ReturnType<typeof createDb>;
  closeDb: () => Promise<void>;
  pingDb: () => Promise<void>;
  redis: ReturnType<typeof createRedisClient>;
  accounts: AccountUseCases;
  inference: Inference;
  modelsReader: {
    listEnabledMappings(): Promise<EnabledModelRow[]>;
  };
  requestLogs: ReturnType<typeof createPgRequestLogStore>;
  billingFacade: Billing;
  rateLimit: RateLimitGate;
  authGuards: {
    keyGuard: ReturnType<typeof createKeyBruteForceGuard>;
    ipGuard: ReturnType<typeof createAuthFailureGuard>;
    trustedProxyHops: number;
  };
  logger: ReturnType<typeof createLogger>;
  otel: ReturnType<typeof initOtel>;
  settleWake: ReturnType<typeof createSettleWakeProducer>;
}

// eslint-disable-next-line max-lines-per-function -- 进程级 DI 装配平铺：逐依赖一次构造、顺序即生命周期契约（铁律 22 ①）
export function assembleGateway(config: GatewayConfig): GatewayAssembly {
  const logger = createLogger({
    level: 'info',
    serviceName: 'gateway',
    pretty: config.nodeEnv !== 'production',
  });
  const db = createDb({
    url: config.databaseUrl,
    poolMax: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    maxUses: 1_000,
  });
  const redis = createRedisClient(config.redisUrl, {
    serviceName: 'gateway',
    logThrottleMs: 5_000,
  });
  const otel = initOtel({
    serviceName: 'gateway',
    serviceVersion: '0.1.0',
    mode: config.otel.mode === 'otlp' ? 'otlp' : 'off',
    ...(config.otel.endpoint != null ? { endpoint: config.otel.endpoint } : {}),
    ...(config.otel.mode === 'otlp'
      ? { metricsExportIntervalMs: config.otel.metricsIntervalMs }
      : {}),
    ...(config.otel.authToken != null ? { authToken: config.otel.authToken } : {}),
    logger,
  });

  // ---- accounts：鉴权读模型 + billing 资金来源解析器（resolver 桥，C-G4） ----
  const walletCreditUnavailable: WalletCreditPort = {
    // 拒绝桩：网关不消费钱包入账动词（client-api 面装配方注入实现），
    // 误调用即刻显式失败（不静默 undefined 崩溃）
    credit: async () => {
      throw new Error('gateway assembly does not provide wallet credit (client-api face owns it)');
    },
  };
  // 会话失效 bridge 同为拒绝桩：网关不改身份事实（client-api/admin-api 面装配方桥接
  // identity anchor advance）；误调用即刻显式失败
  const sessionInvalidationUnavailable: SessionInvalidationPort = {
    invalidateUserSessions: async () => {
      throw new Error(
        'gateway assembly does not provide session invalidation (identity face owns it)',
      );
    },
  };
  const accounts = createAccounts({
    db,
    walletCredit: walletCreditUnavailable,
    sessionInvalidation: sessionInvalidationUnavailable,
    policy: { ...ACCOUNTS_POLICY, keyPrefix: config.keyPrefix },
    txRetry: TX_RETRY,
    now: () => new Date(),
  });

  // ---- billing：结算唤醒门铃 + 积压准入 + facade（store 显式直组——admission 需要
  //      同一 store 实例；一站式便捷件不暴露 store，故走 composition 工厂，R-E4 桥级 admission） ----
  const settleWake = createSettleWakeProducer(db, logger);
  const billingStore = createPostgresBillingStore(db, { retry: TX_RETRY });
  const walletStore = createPostgresWalletStore(db, { retry: TX_RETRY });
  const billingFacade = createBilling(
    {
      walletStore,
      store: billingStore,
      quota: billingStore.quotaStore,
      channels: billingStore.channelStore,
      accounts: billingStore.accountContext,
    },
    {
      resolver: createPgFundingSourceResolver(),
      guards: BILLING_GUARDS,
      currency: config.currency,
      failurePolicy: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8_000 },
      clock: () => new Date(),
      onError: (error, context) =>
        logger.error({ err: String(error), context }, 'billing settlement error'),
      wake: settleWake.wake,
    },
  );
  const assertCapacity = createBillingAdmission({
    maxPending: config.admissionMaxPending,
    maxOldestPendingMs: config.admissionMaxOldestMs,
    store: billingStore,
    clock: () => new Date(),
  });

  // ---- 限流/爆破（Redis 必配形态；fail-closed/degraded 语义归 runtime 件） ----
  const rateLimit: RateLimitGate = {
    limiter: createSlidingWindowLimiter(redis, { logger }),
    globalRpm: config.globalRpm,
  };
  const keyGuard = createKeyBruteForceGuard(redis, {
    failureThreshold: config.authGuards.keyFailureThreshold,
    failureWindowS: config.authGuards.keyFailureWindowS,
    lockS: config.authGuards.keyLockS,
  });
  const ipGuard = createAuthFailureGuard(redis, {
    limit: config.authGuards.ipFailureLimit,
    windowS: config.authGuards.ipFailureWindowS,
  });

  // ---- inference：ai 执行库 + 目录/计费桥 + Redis 健康 + 渠道维 RPM 钩子 ----
  const cipher = createCipher(config.channelApiKeyEncryption);
  const ai = createAi(
    {
      timeout: { connectMs: config.upstreamConnectTimeoutMs, totalMs: config.upstreamDeadlineMs },
    },
    // SSRF 双门：逃生门仅非生产可用——生产误配 env 也恒关（与 v1 同口径）。
    // 生产主防线 = 受信 provider host 白名单（生产必填，config fail-fast）+ DNS 逐地址判定
    config.aiAllowLocalUrl && config.nodeEnv !== 'production'
      ? { guardUrl: async () => {} }
      : {
          guardUrl: async (url: string) => {
            await assertSafeUrl(url, { allowedHosts: config.upstreamAllowedHosts });
          },
        },
  );
  const inference = createInference({
    ai,
    catalog: createPostgresGatewayCatalog(db, {
      ttlMs: config.billingTimezoneTtlMs,
      fallback: config.billingTimezoneFallback,
    }),
    billing: createGatewayBilling(billingFacade.billing, {
      reservationLimit: config.reservationLimit,
      reservationPolicy: config.reservationPolicy,
      assertCapacity,
    }),
    store: createRedisHealthStore(redis, HEALTH_PREFIX),
    decrypt: (enc) => cipher.decrypt(enc),
    tasks: createPostgresGenerationTaskStore(db),
    // 阶段 span 绑定（inference TracePort → OTel；docs/observability.md §3）
    trace: otelTracePort,
    // 渠道维 RPM 尝试前判定（渠道 TPM 预占缺口 R-E3 在案——钩子无请求作用域生命周期）
    admitChannel: async (channel) =>
      tryChannelRpm(rateLimit, {
        channelId: channel.channelId,
        rpmLimit: channel.rpmLimit ?? null,
      }),
    defaults: {
      output: config.output,
      authorization: { ttlMs: config.authorizationTtlMs },
      generation: {
        taskTtlMs: config.generationTaskTtlMs,
        leaseGraceMs: config.generationLeaseGraceMs,
      },
      settleSignal: config.settleSignal,
      upstream: { deadlineMs: config.upstreamDeadlineMs },
    },
    onError: (error, context) => logger.error({ err: String(error), context }, 'inference error'),
  });

  return {
    db,
    closeDb: () => closeDb(db),
    pingDb: () => ping(db),
    redis,
    accounts,
    inference,
    modelsReader: { listEnabledMappings: () => postgresModelStore.listEnabledMappings(db) },
    requestLogs: createPgRequestLogStore(db),
    billingFacade,
    rateLimit,
    authGuards: {
      keyGuard,
      ipGuard,
      trustedProxyHops: config.trustedProxyHops,
    },
    logger,
    otel,
    settleWake,
  };
}
