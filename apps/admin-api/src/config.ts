import * as z from 'zod';
import { secretSchema, strictBooleanSchema } from '@tillgate/runtime';
import type { OtelMode } from '@tillgate/observability';
import type { DbPoolConfig } from '@tillgate/db';

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
export const ADMIN_SESSION_ISSUER = 'tillgate:admin';

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
    /** 虚拟 Key 前缀（与 client-api 生成端、gateway 识别端共用同一 env） */
    KEY_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,15}$/)
      .default('sk_'),
    /** 会话有效期（秒；identity SESSION_TTL_BOUNDS [60, 2592000]） */
    SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(86_400),
    /** 渠道上游 Key 落库加密密钥（AES-256-GCM enc:v1；runtime.createCipher 消费） */
    ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
    /** identity 挑战/恢复码 HMAC pepper（identity 配置必填 16-512 字符；P2 登录波消费） */
    IDENTITY_CODE_PEPPER: secretSchema('IDENTITY_CODE_PEPPER', 16),
    // ---- P2 登录波（DESIGN §2.4「Redis 必配」兑现）----
    /** 爆破守卫/会话吊销面（Redis 必配——不可达 fail-closed 503,不静默降级无锁） */
    REDIS_URL: z.string().url(),
    REDIS_SENTINELS: z.string().min(1).optional(),
    REDIS_SENTINEL_NAME: z.string().min(1).optional(),
    REDIS_SENTINEL_PASSWORD: z.string().min(1).optional(),
    /** 信任代理跳数（x-forwarded-for 右数第 N 跳;0 = 不信代理头） */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    /** (email,ip) 键爆破锁：阈值/窗口/锁时长（v1 auth-guards 同语义,Redis 固定窗口） */
    ADMIN_LOGIN_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    ADMIN_LOGIN_FAILURE_WINDOW_S: z.coerce.number().int().min(1).default(3600),
    ADMIN_LOGIN_LOCK_S: z.coerce.number().int().min(1).default(900),
    /** per-IP 鉴权失败锁（同上） */
    ADMIN_LOGIN_IP_FAILURE_LIMIT: z.coerce.number().int().min(1).default(30),
    ADMIN_LOGIN_IP_FAILURE_WINDOW_S: z.coerce.number().int().min(1).default(3600),
    /** 用户面会话密钥（identity realms 含 'user'——set-password 推进 user 失效线需要;
     * 本 app 绝不签发 user 会话（无任何 sign 调用路径）,仅满足词表一致性） */
    JWT_SECRET: secretSchema('JWT_SECRET', 32),
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
    /** 通知渠道 webhook 本地地址逃生门（P5;与 worker WORKER_WEBHOOK_ALLOW_LOCAL_URL 同语义） */
    ADMIN_WEBHOOK_ALLOW_LOCAL_URL: strictBooleanSchema(false),
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
    /** OTLP 推送鉴权(Bearer)——与 trace-receiver 共用同键同值;缺此值对生产接收端 = span 全部 401 拒收 */
    TRACE_RECEIVER_TOKEN: z.string().min(1).optional(),
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
    if (env.REDIS_SENTINELS != null && env.REDIS_SENTINEL_NAME == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_SENTINEL_NAME'],
        message: 'required when REDIS_SENTINELS is configured',
      });
    }
  });

export interface AdminApiConfig {
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly port: number;
  readonly adminJwtSecret: string;
  readonly keyPrefix: string;
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
  /** 通知渠道 webhook 本地地址逃生门（P5;admin 面只管渠道 CRUD,投递在 worker） */
  readonly webhookAllowLocalUrl: boolean;
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
  readonly otelAuthToken: string | undefined;
  readonly serviceVersion: string;
  readonly otelMetricsIntervalMs: number;
  /** 池调优项(连接串在 databaseUrl,装配时合并——db 包全必填、无缺省) */
  readonly dbPool: Omit<DbPoolConfig, 'url'>;
  // ---- P2 登录波 ----
  readonly redisUrl: string;
  readonly redisTopology:
    | { readonly kind: 'direct' }
    | {
        readonly kind: 'sentinel';
        readonly sentinels: string;
        readonly sentinelName: string;
        readonly sentinelPassword?: string;
      };
  readonly trustedProxyHops: number;
  readonly loginGuard: {
    readonly failureThreshold: number;
    readonly failureWindowS: number;
    readonly lockS: number;
  };
  readonly ipGuard: { readonly limit: number; readonly windowS: number };
  /** 用户面会话密钥（identity realms 词表一致性;本 app 无 user 会话签发路径） */
  readonly userJwtSecret: string;
}

// eslint-disable-next-line max-lines-per-function -- env→config 逐字段搬运(zod schema 映射平铺,分支即字段)
export function loadAdminApiConfig(env: NodeJS.ProcessEnv = process.env): AdminApiConfig {
  const parsed = envSchema.parse(env);
  const otelMode: OtelMode =
    parsed.OTEL_TRACES_MODE ?? (parsed.NODE_ENV === 'production' ? 'off' : 'memory');
  return {
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.ADMIN_API_PORT,
    adminJwtSecret: parsed.ADMIN_JWT_SECRET,
    keyPrefix: parsed.KEY_PREFIX,
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
    webhookAllowLocalUrl: parsed.ADMIN_WEBHOOK_ALLOW_LOCAL_URL,
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
    redisUrl: parsed.REDIS_URL,
    redisTopology:
      parsed.REDIS_SENTINELS == null
        ? { kind: 'direct' }
        : {
            kind: 'sentinel',
            sentinels: parsed.REDIS_SENTINELS,
            sentinelName: parsed.REDIS_SENTINEL_NAME as string,
            ...(parsed.REDIS_SENTINEL_PASSWORD != null
              ? { sentinelPassword: parsed.REDIS_SENTINEL_PASSWORD }
              : {}),
          },
    trustedProxyHops: parsed.TRUSTED_PROXY_HOPS,
    loginGuard: {
      failureThreshold: parsed.ADMIN_LOGIN_FAILURE_THRESHOLD,
      failureWindowS: parsed.ADMIN_LOGIN_FAILURE_WINDOW_S,
      lockS: parsed.ADMIN_LOGIN_LOCK_S,
    },
    ipGuard: {
      limit: parsed.ADMIN_LOGIN_IP_FAILURE_LIMIT,
      windowS: parsed.ADMIN_LOGIN_IP_FAILURE_WINDOW_S,
    },
    userJwtSecret: parsed.JWT_SECRET,
    otelEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelAuthToken: parsed.TRACE_RECEIVER_TOKEN,
    serviceVersion: parsed.OTEL_SERVICE_VERSION,
    otelMetricsIntervalMs: parsed.OTEL_METRICS_INTERVAL_MS,
    dbPool: {
      poolMax: parsed.DB_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    },
  };
}
