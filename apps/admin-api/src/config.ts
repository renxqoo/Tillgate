import { z } from 'zod';
import { secretSchema } from '@tokenlens/runtime';
import type { OtelMode } from '@tokenlens/observability';
import type { DbPoolConfig } from '@tokenlens/db';

/**
 * admin-api 配置（管理控制面）。v1 loadConfig 平移，v2 差异（DESIGN §2.4）：
 *   - REDIS_URL/TRUSTED_PROXY_HOPS 不在本波配置面（无消费方不落地,铁律 4;P2 登录波引入）;
 *   - 新增 IDENTITY_CODE_PEPPER（identity 配置必填项——挑战/恢复码 HMAC pepper）；
 *   - fx 拉取源地址/TTL/超时由 v1 service 常量升为装配显式值（铁律 3）。
 * 部署缺省值由本层显式持有（铁律 3：装配层是缺省值的唯一真相，不藏全局）。
 */

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** 管理面记账币种与钱包词表白名单（wallet guards 装配注入；v1 等价 'CNY'；
 * refTypes 含 accounts 注册赠送/推荐族的 'gift'/'referral'——walletCredit 桥消费） */
const ADMIN_CURRENCY = 'CNY';
const WALLET_REF_TYPES = ['billing', 'topup', 'admin', 'gift', 'referral'] as const;
const WALLET_INTERNAL_ACCOUNTS = ['outside', 'platform_revenue'] as const;

/** 管理面会话 realm：issuer 与用户面/网关物理隔离（token 跨面互斥的根） */
export const ADMIN_SESSION_ISSUER = 'tokenlens:admin';

const nonNegativeDecimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.string().min(1),
    ADMIN_API_PORT: z.coerce.number().int().min(1).default(8082),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    /** 管理面会话 JWT 密钥（admin realm HS256；与用户面物理隔离） */
    ADMIN_JWT_SECRET: secretSchema('ADMIN_JWT_SECRET', 32),
    /** 会话有效期（秒；identity SESSION_TTL_BOUNDS [60, 2592000]） */
    SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(86_400),
    /** 渠道上游 Key 落库加密密钥（AES-256-GCM enc:v1；runtime.createCipher 消费） */
    ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
    /** identity 挑战/恢复码 HMAC pepper（identity 配置必填 16-512 字符；P2 登录波消费） */
    IDENTITY_CODE_PEPPER: secretSchema('IDENTITY_CODE_PEPPER', 16),
    /** 批量导入单次上限（渠道条目数） */
    CHANNEL_IMPORT_MAX: z.coerce.number().int().min(1).default(1000),
    /** 目录导入：免费渠道限流预填（公开免费档限额量级） */
    CATALOG_FREE_CHANNEL_RPM: z.coerce.number().int().min(1).default(20),
    /** 目录导入：免费渠道进货额度预填（上游成本 0，给足余量） */
    CATALOG_FREE_CHANNEL_BUDGET: nonNegativeDecimal.default('1000000'),
    /** 目录源拉取缓存 TTL（ms） */
    CATALOG_CACHE_TTL_MS: z.coerce.number().int().min(1).default(600_000),
    /** OpenRouter 目录源拉取地址与超时（channel 型在线源；v1 同值） */
    OPENROUTER_CATALOG_URL: z.string().url().default('https://openrouter.ai/api/v1/models'),
    CATALOG_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1).default(10_000),
    /** 渠道进货凭证上传上限（字节） */
    VOUCHER_MAX_BYTES: z.coerce.number().int().min(1).default(2_097_152),
    /** fx 拉取（ECB/frankfurter 无 key 公共源；v1 FX_SOURCE_ECB 同值） */
    FX_SOURCE_URL: z.string().url().default('https://api.frankfurter.app/latest?from=USD&to=CNY'),
    /** auto 行拉取节奏（ECB 每工作日一发，4h 懒检查足够新鲜——v1 同值） */
    FX_AUTO_TTL_MS: z.coerce
      .number()
      .int()
      .min(1)
      .default(4 * 60 * 60 * 1000),
    FX_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1).default(10_000),
    /** 结算失败策略（worker 兜底口径；admin 面不触发结算，装配形状必填） */
    SETTLE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    SETTLE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
    SETTLE_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
    /** CORS 白名单（逗号分隔；空 = 不放行跨域） */
    CORS_ORIGINS: z.string().default(''),
    /** 请求体上限（字节；批量导入/凭证内联批次较大） */
    ADMIN_BODY_LIMIT_BYTES: z.coerce.number().int().min(1).default(4_194_304),
    /** 优雅停机宽限上界（ms） */
    ADMIN_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).default(10_000),
    OTEL_TRACES_MODE: z.enum(['off', 'memory', 'console', 'otlp']).optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_VERSION: z.string().min(1).default('0.1.0'),
    OTEL_METRICS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.OTEL_TRACES_MODE === 'otlp' && env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
        message: 'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_TRACES_MODE=otlp',
      });
    }
  });

export interface AdminApiConfig {
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly port: number;
  readonly adminJwtSecret: string;
  readonly sessionTtlSec: number;
  readonly encryptionKey: string;
  readonly identityCodePepper: string;
  readonly channelImportMax: number;
  readonly catalogFreeChannelRpm: number;
  readonly catalogFreeChannelBudget: string;
  readonly catalogCacheTtlMs: number;
  readonly openrouterCatalogUrl: string;
  readonly catalogFetchTimeoutMs: number;
  readonly voucherMaxBytes: number;
  readonly fx: {
    readonly sourceUrl: string;
    readonly autoTtlMs: number;
    readonly fetchTimeoutMs: number;
  };
  readonly settlePolicy: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
  };
  readonly corsOrigins: readonly string[];
  readonly bodyLimitBytes: number;
  readonly shutdownGraceMs: number;
  readonly currency: typeof ADMIN_CURRENCY;
  readonly walletGuards: {
    readonly refTypes: readonly string[];
    readonly currencies: readonly string[];
    readonly internalAccounts: readonly string[];
  };
  /** 缺省:开发 memory / 生产 off(显式配置优先) */
  readonly otelMode: OtelMode;
  readonly otelEndpoint: string | undefined;
  readonly serviceVersion: string;
  readonly otelMetricsIntervalMs: number;
  /** 池调优项(连接串在 databaseUrl,装配时合并——db 包全必填、无缺省) */
  readonly dbPool: Omit<DbPoolConfig, 'url'>;
}

export function loadAdminApiConfig(env: NodeJS.ProcessEnv = process.env): AdminApiConfig {
  const parsed = envSchema.parse(env);
  const otelMode: OtelMode =
    parsed.OTEL_TRACES_MODE ?? (parsed.NODE_ENV === 'production' ? 'off' : 'memory');
  return {
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.ADMIN_API_PORT,
    adminJwtSecret: parsed.ADMIN_JWT_SECRET,
    sessionTtlSec: parsed.SESSION_TTL_SECONDS,
    encryptionKey: parsed.ENCRYPTION_KEY,
    identityCodePepper: parsed.IDENTITY_CODE_PEPPER,
    channelImportMax: parsed.CHANNEL_IMPORT_MAX,
    catalogFreeChannelRpm: parsed.CATALOG_FREE_CHANNEL_RPM,
    catalogFreeChannelBudget: parsed.CATALOG_FREE_CHANNEL_BUDGET,
    catalogCacheTtlMs: parsed.CATALOG_CACHE_TTL_MS,
    openrouterCatalogUrl: parsed.OPENROUTER_CATALOG_URL,
    catalogFetchTimeoutMs: parsed.CATALOG_FETCH_TIMEOUT_MS,
    voucherMaxBytes: parsed.VOUCHER_MAX_BYTES,
    fx: {
      sourceUrl: parsed.FX_SOURCE_URL,
      autoTtlMs: parsed.FX_AUTO_TTL_MS,
      fetchTimeoutMs: parsed.FX_FETCH_TIMEOUT_MS,
    },
    settlePolicy: {
      maxAttempts: parsed.SETTLE_MAX_ATTEMPTS,
      baseDelayMs: parsed.SETTLE_BASE_DELAY_MS,
      maxDelayMs: parsed.SETTLE_MAX_DELAY_MS,
    },
    corsOrigins:
      parsed.CORS_ORIGINS === '' ? [] : parsed.CORS_ORIGINS.split(',').map((s) => s.trim()),
    bodyLimitBytes: parsed.ADMIN_BODY_LIMIT_BYTES,
    shutdownGraceMs: parsed.ADMIN_SHUTDOWN_GRACE_MS,
    currency: ADMIN_CURRENCY,
    walletGuards: {
      refTypes: WALLET_REF_TYPES,
      currencies: [ADMIN_CURRENCY],
      internalAccounts: WALLET_INTERNAL_ACCOUNTS,
    },
    otelMode,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceVersion: parsed.OTEL_SERVICE_VERSION,
    otelMetricsIntervalMs: parsed.OTEL_METRICS_INTERVAL_MS,
    dbPool: {
      poolMax: parsed.DB_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      maxUses: 1_000,
    },
  };
}
