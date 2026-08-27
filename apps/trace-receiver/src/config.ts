import * as z from 'zod';
import { secretSchema } from '@tillgate/runtime';
import type { OtelMode } from '@tillgate/observability';
import type { DbPoolConfig } from '@tillgate/db';

/**
 * trace-receiver 配置(内网诊断服务):
 *   - DATABASE_URL 必填——db 包零缺省,不藏默认连接串;
 *   - 令牌走 secretSchema 三道门(长度 ≥16/非已知弱值/字符多样性,runtime 组装件);
 *   - NODE_ENV 纳入 schema:生产环境缺令牌时 fail-fast。
 * 部署缺省值由本层显式持有:装配层是缺省值的唯一真相,不藏全局。
 */

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.string().min(1),
    TRACE_RECEIVER_PORT: z.coerce.number().int().min(1).default(8793),
    TRACE_RECEIVER_TOKEN: secretSchema('TRACE_RECEIVER_TOKEN', 16).optional(),
    TRACE_BATCH_MAX: z.coerce.number().int().min(1).default(500),
    TRACE_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
    TRACE_QUEUE_MAX: z.coerce.number().int().min(100).default(10_000),
    OTEL_TRACES_MODE: z.enum(['off', 'memory', 'console', 'otlp']).optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    /** 服务版本(OTel 资源属性;缺省取部署包版本字面量——装配层显式持有) */
    OTEL_SERVICE_VERSION: z.string().min(1).default('0.1.0'),
    /** OTLP 指标推送周期毫秒(otlp 模式必填——observability 已收必填,缺省在此显式持有) */
    OTEL_METRICS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.TRACE_RECEIVER_TOKEN === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRACE_RECEIVER_TOKEN'],
        message: 'TRACE_RECEIVER_TOKEN is required in production (receiver auth)',
      });
    }
  });

export interface TraceReceiverConfig {
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly port: number;
  /** 共享鉴权令牌;undefined = 开发内网放行(生产由 schema fail-fast 强制) */
  readonly receiverToken: string | undefined;
  readonly batchMax: number;
  readonly flushIntervalMs: number;
  readonly queueMax: number;
  /** 缺省:开发 memory / 生产 off(显式配置优先) */
  readonly otelMode: OtelMode;
  readonly otelEndpoint: string | undefined;
  /** OTel 资源版本与指标周期(装配显式值,observability 侧已无藏缺省) */
  readonly serviceVersion: string;
  readonly otelMetricsIntervalMs: number;
  /** 池调优项(连接串在 databaseUrl,装配时合并——db 包全必填、无缺省) */
  readonly dbPool: Omit<DbPoolConfig, 'url'>;
}

/** PG 池部署定值:接收端是低流量诊断服务,10 连接远超双副本吞吐需求 */
const DB_POOL: Omit<DbPoolConfig, 'url'> = {
  poolMax: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export function loadTraceReceiverConfig(env: NodeJS.ProcessEnv = process.env): TraceReceiverConfig {
  const parsed = envSchema.parse(env);
  const otelMode: OtelMode =
    parsed.OTEL_TRACES_MODE ?? (parsed.NODE_ENV === 'production' ? 'off' : 'memory');
  return {
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.TRACE_RECEIVER_PORT,
    receiverToken: parsed.TRACE_RECEIVER_TOKEN,
    batchMax: parsed.TRACE_BATCH_MAX,
    flushIntervalMs: parsed.TRACE_FLUSH_INTERVAL_MS,
    queueMax: parsed.TRACE_QUEUE_MAX,
    otelMode,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceVersion: parsed.OTEL_SERVICE_VERSION,
    otelMetricsIntervalMs: parsed.OTEL_METRICS_INTERVAL_MS,
    dbPool: DB_POOL,
  };
}
