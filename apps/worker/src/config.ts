/**
 * worker 配置：env schema + 缺省 + fail-closed。一切可变值装配注入且必填/显式
 * 缺省——本层是缺省值唯一真相。环境键名保持稳定（运维接口连续性）：
 *   - WORKER_REDIS_URL（回落 REDIS_URL）必配 fail-closed——BullMQ 结算调度
 *     以队列做毒账单进程隔离；
 *   - WORKER_GENERATION_DEADLINE_MS / WORKER_GENERATION_MAX_RETRIES：
 *     music 代执行的上游预算；
 *   - WORKER_REFERRAL_BACKFILL_DAYS / WORKER_NOTIFY_* 投递参数。
 */
import * as z from 'zod';
import { secretSchema, strictBooleanSchema } from '@tillgate/runtime';
import type { SentinelTopology } from '@tillgate/runtime';
import type { OtelMode } from '@tillgate/observability';
import type { DbPoolConfig } from '@tillgate/db';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** 非负十进制金额串 */
const nonNegativeDecimal = z
  .string()
  .regex(/^\d{1,20}(\.\d{1,18})?$/, 'must be a non-negative decimal string');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.string().min(1),
    WORKER_CURRENCY: z.string().min(1).default('CNY'),
    WORKER_OWNER_ID: z.string().min(1).default(`worker-${process.pid}`),

    // ---- 结算 ----
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).default(20),
    WORKER_CLAIM_LEASE_MS: z.coerce.number().int().min(1).default(60_000),
    /** 10 次 × 分钟级退避 ≈ 85 分钟耐受 */
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
    WORKER_BASE_DELAY_MS: z.coerce.number().int().min(1).default(15_000),
    WORKER_MAX_DELAY_MS: z.coerce.number().int().min(1).default(600_000),
    WORKER_SETTLE_WAKE: strictBooleanSchema(true),
    /** 用量证据缺陷熔断阈值（结算验收门钳制计数 ≥ 阈值 → 渠道熔断） */
    WORKER_USAGE_DEFECT_BREAKER: z.coerce.number().int().min(1).default(5),
    WORKER_SETTLE_INTERVAL_MS: z.coerce.number().int().min(1).default(30_000),
    // ---- BullMQ 结算调度(2026-08-26 增量):连接/前缀/并发/保险丝 ----
    WORKER_REDIS_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    REDIS_SENTINELS: z.string().min(1).optional(),
    REDIS_SENTINEL_NAME: z.string().min(1).optional(),
    REDIS_SENTINEL_PASSWORD: z.string().min(1).optional(),
    WORKER_BULLMQ_PREFIX: z.string().min(1).default('{bull}'),
    WORKER_SETTLE_CONCURRENCY: z.coerce.number().int().min(1).default(8),
    WORKER_SETTLE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
    /** 批量结算每轮上限（含被通知的这条；1 = 关闭批量）。结算吞吐瓶颈在
     * platform_revenue 单行串行化——批内共享事务一次拿放账户锁摊薄成本。 */
    WORKER_SETTLE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    WORKER_RECOVER_INTERVAL_MS: z.coerce.number().int().min(1).default(15_000),
    WORKER_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).default(50),

    // ---- 生成任务轮询 ----
    WORKER_GENERATION_INTERVAL_MS: z.coerce.number().int().min(1).default(5_000),
    WORKER_GENERATION_BATCH_SIZE: z.coerce.number().int().min(1).default(20),
    /** 须 ≥ 2× 轮询间隔 */
    WORKER_GENERATION_LEASE_MS: z.coerce.number().int().min(1).default(30_000),
    WORKER_GENERATION_EXPIRE_REASON: z.string().default('任务超时（TTL 到期）'),
    WORKER_GENERATION_DEADLINE_MS: z.coerce.number().int().min(1_000).default(300_000),
    WORKER_GENERATION_MAX_RETRIES: z.coerce.number().int().min(0).default(2),

    // ---- 佣金日结 ----
    WORKER_REFERRAL_INTERVAL_MS: z.coerce.number().int().min(1).default(3_600_000),
    WORKER_REFERRAL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(62).default(7),

    // ---- 告警投递 ----
    WORKER_NOTIFY_ENABLED: strictBooleanSchema(true),
    WORKER_NOTIFY_INTERVAL_MS: z.coerce.number().int().min(1).default(15_000),
    /** 须覆盖 webhook 超时与 SMTP 上界 */
    WORKER_NOTIFY_CLAIM_LEASE_MS: z.coerce.number().int().min(15_000).default(60_000),
    WORKER_NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    WORKER_NOTIFY_LOOP_BATCH_LIMIT: z.coerce.number().int().min(1).default(50),
    WORKER_NOTIFY_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
    WORKER_NOTIFY_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(15_000),
    WORKER_NOTIFY_BACKOFF_CAP_MS: z.coerce.number().int().min(1).default(600_000),

    // ---- 对账与分区 ----
    WORKER_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1).default(3_600_000),
    WORKER_PARTITION_INTERVAL_MS: z.coerce.number().int().min(1).default(3_600_000),
    TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
    REQUEST_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

    // ---- 钩子与端点 ----
    WORKER_BALANCE_LOW_THRESHOLD: nonNegativeDecimal.default('5'),
    /** 0 = 关闭健康端点 */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8792),
    /** 空/缺省 = /health 恒 403（深度报告需令牌） */
    WORKER_HEALTH_TOKEN: z.string().optional(),
    WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).default(15_000),

    // ---- 上游与逃生门 ----
    // 对称加密根密钥（AES-256-GCM enc:v1）：渠道上游 Key 解密 + integration settings
    // 密钥解密共用；与 admin-api/client-api 同键（跨进程加解密必须一致）
    ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
    WORKER_AI_ALLOW_LOCAL_URL: strictBooleanSchema(false),
    WORKER_WEBHOOK_ALLOW_LOCAL_URL: strictBooleanSchema(false),

    // ---- 邮件渠道（三要素缺一 = 不装配，email 渠道 fail-closed）----

    // ---- 观测 ----
    /** 链路追踪默认开启（otlp 推送；关闭显式设 off） */
    OTEL_TRACES_MODE: z.enum(['off', 'memory', 'console', 'otlp']).default('otlp'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://trace-receiver:8793'),
    TRACE_RECEIVER_TOKEN: z.string().min(1).optional(),
    OTEL_SERVICE_VERSION: z.string().min(1).default('0.1.0'),
    OTEL_METRICS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  })
  .superRefine((v, ctx) => {
    if (v.REDIS_SENTINELS != null && v.REDIS_SENTINEL_NAME == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_SENTINEL_NAME'],
        message: 'required when REDIS_SENTINELS is configured',
      });
    }
  });

export interface WorkerConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly currency: string;
  readonly ownerId: string;

  readonly usageDefectBreaker: number;
  readonly settle: {
    readonly batchSize: number;
    /** 批量结算每轮上限（1 = 关闭批量） */
    readonly settleBatchSize: number;
    readonly claimLeaseMs: number;
    readonly failurePolicy: {
      readonly maxAttempts: number;
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
    };
    readonly wake: boolean;
    readonly intervalMs: number;
    readonly bullmq: {
      readonly redisUrl: string;
      readonly prefix: string;
      readonly concurrency: number;
      readonly maxAttempts: number;
    } & SentinelTopology;
  };
  readonly recover: { readonly intervalMs: number; readonly batchSize: number };
  readonly generation: {
    readonly intervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly expireReason: string;
    readonly executeDeadlineMs: number;
    readonly executeMaxRetries: number;
  };
  readonly referral: { readonly intervalMs: number; readonly backfillDays: number };
  readonly notify: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly dispatch: {
      readonly claimLeaseMs: number;
      readonly maxAttempts: number;
      readonly loopBatchLimit: number;
      readonly webhookTimeoutMs: number;
      readonly backoffBaseMs: number;
      readonly backoffCapMs: number;
      readonly emailBrand: string;
    };
  };
  readonly reconcile: { readonly intervalMs: number };
  readonly partition: {
    readonly intervalMs: number;
    readonly traceRetentionDays: number;
    readonly requestLogRetentionDays: number;
  };
  readonly balanceLowThreshold: string;
  readonly health: { readonly port: number; readonly token: string | undefined };
  readonly shutdownGraceMs: number;

  readonly encryptionKey: string;
  readonly aiAllowLocalUrl: boolean;
  readonly webhookAllowLocalUrl: boolean;

  readonly otelMode: OtelMode;
  readonly otelEndpoint: string | undefined;
  readonly otelAuthToken: string | undefined;
  readonly serviceVersion: string;
  readonly otelMetricsIntervalMs: number;
  /** 池调优项（连接串在 databaseUrl，装配时合并——db 包全必填、无缺省） */
  readonly dbPool: Omit<DbPoolConfig, 'url'>;
}

/** PG 池部署定值：worker 并发 = 认领批量 + 轮询/维护余量。
 * 池-并发不变量在 assembly 从 runner 注册表派生断言（单一真相），此处只持定值。 */
const DB_POOL: Omit<DbPoolConfig, 'url'> = {
  poolMax: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

/** BullMQ 连接串:WORKER_REDIS_URL 优先,回落 REDIS_URL;两者皆缺 = fail-closed(结算调度无队列不可用) */
function redisUrlOf(parsed: { WORKER_REDIS_URL?: string; REDIS_URL?: string }): string {
  const url = parsed.WORKER_REDIS_URL ?? parsed.REDIS_URL;
  if (url == null || url.length === 0) {
    throw new Error('WORKER_REDIS_URL (or REDIS_URL) is required for BullMQ settlement dispatch');
  }
  return url;
}

// eslint-disable-next-line max-lines-per-function -- env→config 逐字段搬运(zod schema 映射平铺,分支即字段)
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.parse(env);
  const otelMode: OtelMode = parsed.OTEL_TRACES_MODE;

  // SentinelTopology 是判别联合，须按分支显式构造（条件 spread 会把字段降级为可选）
  const bullmqBase = {
    redisUrl: redisUrlOf(parsed),
    prefix: parsed.WORKER_BULLMQ_PREFIX,
    concurrency: parsed.WORKER_SETTLE_CONCURRENCY,
    maxAttempts: parsed.WORKER_SETTLE_MAX_ATTEMPTS,
  };
  const bullmq: WorkerConfig['settle']['bullmq'] =
    parsed.REDIS_SENTINELS != null
      ? {
          ...bullmqBase,
          sentinels: parsed.REDIS_SENTINELS,
          sentinelName: parsed.REDIS_SENTINEL_NAME as string,
          ...(parsed.REDIS_SENTINEL_PASSWORD != null
            ? { sentinelPassword: parsed.REDIS_SENTINEL_PASSWORD }
            : {}),
        }
      : { ...bullmqBase };

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    currency: parsed.WORKER_CURRENCY,
    ownerId: parsed.WORKER_OWNER_ID,
    usageDefectBreaker: parsed.WORKER_USAGE_DEFECT_BREAKER,
    settle: {
      batchSize: parsed.WORKER_BATCH_SIZE,
      settleBatchSize: parsed.WORKER_SETTLE_BATCH_SIZE,
      claimLeaseMs: parsed.WORKER_CLAIM_LEASE_MS,
      failurePolicy: {
        maxAttempts: parsed.WORKER_MAX_ATTEMPTS,
        baseDelayMs: parsed.WORKER_BASE_DELAY_MS,
        maxDelayMs: parsed.WORKER_MAX_DELAY_MS,
      },
      wake: parsed.WORKER_SETTLE_WAKE,
      intervalMs: parsed.WORKER_SETTLE_INTERVAL_MS,
      bullmq,
    },
    recover: {
      intervalMs: parsed.WORKER_RECOVER_INTERVAL_MS,
      batchSize: parsed.WORKER_RECOVERY_BATCH_SIZE,
    },
    generation: {
      intervalMs: parsed.WORKER_GENERATION_INTERVAL_MS,
      batchSize: parsed.WORKER_GENERATION_BATCH_SIZE,
      leaseMs: parsed.WORKER_GENERATION_LEASE_MS,
      expireReason: parsed.WORKER_GENERATION_EXPIRE_REASON,
      executeDeadlineMs: parsed.WORKER_GENERATION_DEADLINE_MS,
      executeMaxRetries: parsed.WORKER_GENERATION_MAX_RETRIES,
    },
    referral: {
      intervalMs: parsed.WORKER_REFERRAL_INTERVAL_MS,
      backfillDays: parsed.WORKER_REFERRAL_BACKFILL_DAYS,
    },
    notify: {
      enabled: parsed.WORKER_NOTIFY_ENABLED,
      intervalMs: parsed.WORKER_NOTIFY_INTERVAL_MS,
      dispatch: {
        claimLeaseMs: parsed.WORKER_NOTIFY_CLAIM_LEASE_MS,
        maxAttempts: parsed.WORKER_NOTIFY_MAX_ATTEMPTS,
        loopBatchLimit: parsed.WORKER_NOTIFY_LOOP_BATCH_LIMIT,
        webhookTimeoutMs: parsed.WORKER_NOTIFY_WEBHOOK_TIMEOUT_MS,
        backoffBaseMs: parsed.WORKER_NOTIFY_BACKOFF_BASE_MS,
        backoffCapMs: parsed.WORKER_NOTIFY_BACKOFF_CAP_MS,
        emailBrand: 'Tillgate 运维告警',
      },
    },
    reconcile: { intervalMs: parsed.WORKER_RECONCILE_INTERVAL_MS },
    partition: {
      intervalMs: parsed.WORKER_PARTITION_INTERVAL_MS,
      traceRetentionDays: parsed.TRACE_RETENTION_DAYS,
      requestLogRetentionDays: parsed.REQUEST_LOG_RETENTION_DAYS,
    },
    balanceLowThreshold: parsed.WORKER_BALANCE_LOW_THRESHOLD,
    health: { port: parsed.WORKER_HEALTH_PORT, token: parsed.WORKER_HEALTH_TOKEN },
    shutdownGraceMs: parsed.WORKER_SHUTDOWN_GRACE_MS,
    encryptionKey: parsed.ENCRYPTION_KEY,
    aiAllowLocalUrl: parsed.WORKER_AI_ALLOW_LOCAL_URL,
    webhookAllowLocalUrl: parsed.WORKER_WEBHOOK_ALLOW_LOCAL_URL,
    otelMode,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelAuthToken: parsed.TRACE_RECEIVER_TOKEN,
    serviceVersion: parsed.OTEL_SERVICE_VERSION,
    otelMetricsIntervalMs: parsed.OTEL_METRICS_INTERVAL_MS,
    dbPool: DB_POOL,
  };
}
