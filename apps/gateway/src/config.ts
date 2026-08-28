/**
 * gateway 配置：env schema + 缺省 + 生产 fail-fast。
 * 一切可变值装配注入且必填/显式缺省——本层是缺省值唯一真相。
 * 环境键名保持稳定（运维接口连续性）。
 */
import * as z from 'zod';
import { secretSchema, strictBooleanSchema } from '@tillgate/runtime';

const BYTES_RE = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i;

/** IANA 时区合法性（Intl 构造抛错即非法——启动 fail-fast，热路径 formatter 直接复用） */
function isValidTimezone(tz: string): boolean {
  try {
    // 构造即探测:非法时区抛 RangeError;作函数调用返回实例(等价 new,规避副作用 new)
    return Intl.DateTimeFormat('en-US', { timeZone: tz }) instanceof Intl.DateTimeFormat;
  } catch {
    return false;
  }
}

/** 字节量（"10MB" 形） */
const byteSize = z.string().regex(BYTES_RE, 'must be like "10MB"');

/** 字节单位换算表（与 BYTES_RE 的封闭词表 b/kb/mb/gb 一一对应） */
const BYTES_UNIT: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

const bytesOf = (v: string): number => {
  // 入参恒为 byteSize schema 校验过的字面量；此处显式收窄而非断言（null 即形状矛盾）
  const m = BYTES_RE.exec(v);
  if (m == null || m[1] == null || m[2] == null) {
    throw new Error(`invalid byte size literal: ${v}`);
  }
  const factor = BYTES_UNIT[m[2].toLowerCase()];
  if (factor == null) {
    throw new Error(`unknown byte unit: ${m[2]}`);
  }
  return Math.floor(Number(m[1]) * factor);
};

// eslint-disable-next-line max-lines-per-function -- env schema 逐键平铺的纯配置数据
function createSchema(production: boolean) {
  return z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
      DATABASE_URL: z.string().url(),
      REDIS_URL: z.string().url(),
      REDIS_SENTINELS: z.string().min(1).optional(),
      REDIS_SENTINEL_NAME: z.string().min(1).optional(),
      REDIS_SENTINEL_PASSWORD: z.string().min(1).optional(),
      DB_POOL_MAX: z.coerce.number().int().min(1).max(300).default(10),
      ADMISSION_MAX_PENDING: z.coerce.number().int().min(1).default(10_000),
      ADMISSION_MAX_OLDEST_MS: z.coerce.number().int().min(1_000).default(300_000),
      /** 用量证据缺陷熔断阈值（验收门钳制计数 ≥ 阈值 → 渠道熔断） */
      BILLING_USAGE_DEFECT_BREAKER: z.coerce.number().int().min(1).default(5),
      /** 预扣策略（system_configs KV）缓存 TTL——admin 改动后的拾取延迟上界 */
      BILLING_RESERVATION_POLICY_TTL_MS: z.coerce.number().int().min(1_000).default(15_000),
      BILLING_AUTHORIZATION_TTL_MS: z.coerce.number().int().min(1_000).default(300_000),
      /** 计费时区（全系统统一；schedule 分时段策略的墙钟口径）缓存 TTL */
      BILLING_TIMEZONE_TTL_MS: z.coerce.number().int().min(1_000).default(60_000),
      /** system_configs 未配置 billing_timezone 时的回落（IANA 名，启动即验合法性） */
      BILLING_TIMEZONE_DEFAULT: z
        .string()
        .refine((tz) => isValidTimezone(tz), { message: 'invalid IANA timezone' })
        .default('Asia/Shanghai'),
      GENERATION_TASK_TTL_MS: z.coerce.number().int().min(1_000).default(3_600_000),
      GENERATION_LEASE_GRACE_MS: z.coerce.number().int().min(0).default(30_000),
      AUTH_KEY_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
      AUTH_KEY_FAILURE_WINDOW_S: z.coerce.number().int().min(1).default(600),
      AUTH_KEY_LOCK_S: z.coerce.number().int().min(1).default(600),
      AUTH_IP_FAILURE_LIMIT: z.coerce.number().int().min(1).default(30),
      AUTH_IP_FAILURE_WINDOW_S: z.coerce.number().int().min(1).default(300),
      TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
      GLOBAL_RPM: z.coerce.number().int().min(0).default(2_000),
      /** 预认证 per-IP RPM（鉴权前第一道闸；0 = 不设） */
      PREAUTH_IP_RPM: z.coerce.number().int().min(0).default(1_200),
      GATEWAY_UPSTREAM_DEADLINE_MS: z.coerce.number().int().min(1_000).default(120_000),
      GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
      /** SSRF 逃生门：仅非生产可用——生产误配 env 也恒关（与 admin-api 同口径） */
      GATEWAY_AI_ALLOW_LOCAL_URL: strictBooleanSchema(false),
      GATEWAY_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).default(60_000),
      /** 宽限耗尽 abort 在途请求后的收尾窗（信号结算/释放；再强退） */
      GATEWAY_DRAIN_FINALIZE_MS: z.coerce.number().int().min(1_000).default(5_000),
      OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
      OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
      /** OTLP 推送鉴权(Bearer)——与 trace-receiver 共用同键同值;缺此值对生产接收端 = span 全部 401 拒收 */
      TRACE_RECEIVER_TOKEN: z.string().min(1).optional(),
      OTEL_METRICS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
      DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).default(4_096),
      GATEWAY_OUTPUT_EXPOSURE_CAP: z.coerce.number().int().min(1).default(32_768),
      GATEWAY_BODY_LIMIT_BYTES: byteSize.default('10MB'),
      GATEWAY_UPLOAD_MAX_FILE_BYTES: byteSize.default('16MB'),
      GATEWAY_UPLOAD_IMAGE_MIME: z.string().default('image/png,image/jpeg,image/webp'),
      GATEWAY_UPLOAD_AUDIO_MIME: z
        .string()
        .default(
          'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/webm,audio/mp4,audio/x-m4a,audio/m4a',
        ),
      SIGNAL_FINALIZE_ATTEMPTS: z.coerce.number().int().min(1).default(5),
      SIGNAL_FINALIZE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(500),
      KEY_PREFIX: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{1,15}$/, 'must be 2-16 chars [a-z0-9_-] starting with a letter')
        .default('sk_'),
      JWT_ISSUER: z.string().min(1).default('ai-gateway'),
      JWT_AUDIENCE: z.string().min(1).default('ai-gateway-api'),
      JWT_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(3_600),
      JWT_SECRET: secretSchema('JWT_SECRET', production ? 32 : 16),
      ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
      GATEWAY_CORS_ORIGINS: z.string().default(''),
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
}

export interface GatewayConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly redisTopology:
    | { readonly kind: 'direct' }
    | {
        readonly kind: 'sentinel';
        readonly sentinels: string;
        readonly sentinelName: string;
        readonly sentinelPassword?: string;
      };
  readonly dbPoolMax: number;
  readonly admissionMaxPending: number;
  readonly admissionMaxOldestMs: number;
  readonly usageDefectBreaker: number;
  /** 预扣策略 KV 读缓存 TTL（策略本体在 system_configs，admin 面动态调整） */
  readonly reservationPolicyTtlMs: number;
  readonly authorizationTtlMs: number;
  /** 计费时区缓存 TTL（system_configs 读取）与回落时区 */
  readonly billingTimezoneTtlMs: number;
  readonly billingTimezoneFallback: string;
  readonly generationTaskTtlMs: number;
  readonly generationLeaseGraceMs: number;
  readonly authGuards: {
    keyFailureThreshold: number;
    keyFailureWindowS: number;
    keyLockS: number;
    ipFailureLimit: number;
    ipFailureWindowS: number;
  };
  readonly trustedProxyHops: number;
  /** null = 不限（0 视为不限） */
  readonly globalRpm: number | null;
  /** 预认证 per-IP RPM（null = 不设；鉴权前的未认证洪水闸） */
  readonly preauthIpRpm: number | null;
  readonly upstreamDeadlineMs: number;
  readonly upstreamConnectTimeoutMs: number;
  readonly aiAllowLocalUrl: boolean;
  readonly shutdownGraceMs: number;
  readonly drainFinalizeMs: number;
  readonly otel: {
    mode: 'off' | 'otlp';
    endpoint?: string;
    metricsIntervalMs: number;
    authToken?: string;
  };
  readonly output: { defaultMaxOutputTokens: number; exposureCap: number };
  readonly settleSignal: { attempts: number; baseDelayMs: number };
  readonly bodyLimitBytes: number;
  readonly uploadLimits: {
    imageMime: ReadonlySet<string>;
    audioMime: ReadonlySet<string>;
    maxFileBytes: number;
  };
  readonly keyPrefix: string;
  readonly oauth: { jwtSecret: string; issuer: string; audience: string; tokenTtlSeconds: number };
  readonly encryptionKey: string;
  readonly corsOrigins: readonly string[];
}

/**
 * accounts 装配 policy（部署定值：网关只消费鉴权读模型，但 policy
 * 必填且形状 fail-fast；装配层是缺省值唯一真相）
 */
export const ACCOUNTS_POLICY = {
  invitationTtlMs: 7 * 24 * 3_600_000,
  invitationPendingFactor: 2,
  invitationPendingCap: 20,
  amountLimitUpper: '1000000000000',
  rpmLimitMax: 1_000_000,
  tpmLimitMax: 100_000_000,
  /** App scope.models 白名单上界 */
  scopeModelsMax: 100,
  referralInviteeLimit: 100,
  listPage: { page: 1, limit: 20, maxLimit: 100 },
  banDefaultReason: 'administrator banned account',
} as const;

/** billing 钱包词表白名单（billing guards 必填） */
/**
 * 钱包守卫词表（币种维度自平台币种派生——单一真相在 system_configs KV；
 * 旧白名单的 'USD' 项全库无调用方，随 env 币种一并收敛）
 */
export function billingGuardsOf(platformCurrency: string) {
  return {
    refTypes: ['billing', 'topup', 'admin', 'gift'],
    currencies: [platformCurrency],
    internalAccounts: ['outside', 'platform_revenue'],
  } as const;
}

const mimeSetOf = (raw: string): Set<string> =>
  new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** 废弃键告警（用户级限流无兜底默认——残留键提示迁移） */
const DEPRECATED_KEYS = [
  'DEFAULT_USER_RPM',
  'DEFAULT_USER_TPM',
  'FREE_MODEL_DAILY_LIMIT',
  'GENERATION_MAX_ACTIVE_PER_USER',
] as const;

/** Redis 拓扑收窄：schema 已保证 Sentinel 节点在场时主名必定在场。 */
function redisTopologyOf(parsed: {
  REDIS_SENTINELS?: string;
  REDIS_SENTINEL_NAME?: string;
  REDIS_SENTINEL_PASSWORD?: string;
}): GatewayConfig['redisTopology'] {
  if (parsed.REDIS_SENTINELS == null) return { kind: 'direct' };
  return {
    kind: 'sentinel',
    sentinels: parsed.REDIS_SENTINELS,
    sentinelName: parsed.REDIS_SENTINEL_NAME as string,
    ...(parsed.REDIS_SENTINEL_PASSWORD != null
      ? { sentinelPassword: parsed.REDIS_SENTINEL_PASSWORD }
      : {}),
  };
}

/** 限流 RPM 键归一：0/null → null（0 = 不设闸） */
function rpmOrNull(value: number): number | null {
  return value > 0 ? value : null;
}

// eslint-disable-next-line max-lines-per-function -- env → GatewayConfig 逐字段搬运的纯配置映射
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // 弃用键：告警后剔除出解析输入（过滤式构造替代动态 delete，行为等价）
  const deprecated = new Set<string>(DEPRECATED_KEYS);
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (deprecated.has(key)) {
      if (value != null && value !== '') {
        console.warn(
          `[gateway] config key ${key} is deprecated and ignored (user-level limits have no default)`,
        );
      }
      continue;
    }
    raw[key] = value;
  }
  const parsed = createSchema(raw.NODE_ENV === 'production').parse(raw);

  // 生产 GLOBAL_RPM 硬顶（超配钳到 5000 并告警）
  let globalRpm: number | null = parsed.GLOBAL_RPM > 0 ? parsed.GLOBAL_RPM : null;
  if (parsed.NODE_ENV === 'production' && globalRpm != null && globalRpm > 5_000) {
    console.warn(`[gateway] GLOBAL_RPM ${globalRpm} clamped to 5000 in production`);
    globalRpm = 5_000;
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.GATEWAY_PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    redisTopology: redisTopologyOf(parsed),
    dbPoolMax: parsed.DB_POOL_MAX,
    admissionMaxPending: parsed.ADMISSION_MAX_PENDING,
    admissionMaxOldestMs: parsed.ADMISSION_MAX_OLDEST_MS,
    usageDefectBreaker: parsed.BILLING_USAGE_DEFECT_BREAKER,
    reservationPolicyTtlMs: parsed.BILLING_RESERVATION_POLICY_TTL_MS,
    authorizationTtlMs: parsed.BILLING_AUTHORIZATION_TTL_MS,
    billingTimezoneTtlMs: parsed.BILLING_TIMEZONE_TTL_MS,
    billingTimezoneFallback: parsed.BILLING_TIMEZONE_DEFAULT,
    generationTaskTtlMs: parsed.GENERATION_TASK_TTL_MS,
    generationLeaseGraceMs: parsed.GENERATION_LEASE_GRACE_MS,
    authGuards: {
      keyFailureThreshold: parsed.AUTH_KEY_FAILURE_THRESHOLD,
      keyFailureWindowS: parsed.AUTH_KEY_FAILURE_WINDOW_S,
      keyLockS: parsed.AUTH_KEY_LOCK_S,
      ipFailureLimit: parsed.AUTH_IP_FAILURE_LIMIT,
      ipFailureWindowS: parsed.AUTH_IP_FAILURE_WINDOW_S,
    },
    trustedProxyHops: parsed.TRUSTED_PROXY_HOPS,
    globalRpm,
    preauthIpRpm: rpmOrNull(parsed.PREAUTH_IP_RPM),
    upstreamDeadlineMs: parsed.GATEWAY_UPSTREAM_DEADLINE_MS,
    upstreamConnectTimeoutMs: parsed.GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS,
    aiAllowLocalUrl: parsed.GATEWAY_AI_ALLOW_LOCAL_URL,
    shutdownGraceMs: parsed.GATEWAY_SHUTDOWN_GRACE_MS,
    drainFinalizeMs: parsed.GATEWAY_DRAIN_FINALIZE_MS,
    otel: {
      metricsIntervalMs: parsed.OTEL_METRICS_INTERVAL_MS,
      ...(parsed.OTEL_TRACES_MODE === 'otlp' && parsed.OTEL_EXPORTER_OTLP_ENDPOINT != null
        ? { mode: 'otlp' as const, endpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }
        : { mode: parsed.OTEL_TRACES_MODE }),
      ...(parsed.TRACE_RECEIVER_TOKEN != null ? { authToken: parsed.TRACE_RECEIVER_TOKEN } : {}),
    },
    output: {
      defaultMaxOutputTokens: parsed.DEFAULT_MAX_OUTPUT_TOKENS,
      exposureCap: parsed.GATEWAY_OUTPUT_EXPOSURE_CAP,
    },
    settleSignal: {
      attempts: parsed.SIGNAL_FINALIZE_ATTEMPTS,
      baseDelayMs: parsed.SIGNAL_FINALIZE_BASE_DELAY_MS,
    },
    bodyLimitBytes: bytesOf(parsed.GATEWAY_BODY_LIMIT_BYTES),
    uploadLimits: {
      imageMime: mimeSetOf(parsed.GATEWAY_UPLOAD_IMAGE_MIME),
      audioMime: mimeSetOf(parsed.GATEWAY_UPLOAD_AUDIO_MIME),
      maxFileBytes: Math.min(
        bytesOf(parsed.GATEWAY_UPLOAD_MAX_FILE_BYTES),
        bytesOf(parsed.GATEWAY_BODY_LIMIT_BYTES),
      ),
    },
    keyPrefix: parsed.KEY_PREFIX,
    oauth: {
      jwtSecret: parsed.JWT_SECRET,
      issuer: parsed.JWT_ISSUER,
      audience: parsed.JWT_AUDIENCE,
      tokenTtlSeconds: parsed.JWT_TOKEN_TTL_SECONDS,
    },
    encryptionKey: parsed.ENCRYPTION_KEY,
    corsOrigins: parsed.GATEWAY_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
