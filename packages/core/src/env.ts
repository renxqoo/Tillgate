import { z } from 'zod';

/**
 * 环境变量校验（所有服务共用 schema，各自扩展）。
 *
 * B3 修复：密钥强度校验。拒绝已知占位/弱密钥（黑名单 + 最低熵要求），
 * 防止照抄 .env.example 部署 → JWT 可伪造 + 渠道 Key 可解密。生产环境额外严格。
 */
const KNOWN_WEAK_SECRETS = new Set([
  'change-me',
  'secret',
  'password',
  'changeme',
  'test-jwt-secret-min-16-chars',
  'test-encryption-key-32-chars-min!!',
  'change-me-32-chars-minimum-secret',
]);

function secretSchema(field: string, minLen: number) {
  return z
    .string()
    .min(minLen, `${field} 至少 ${minLen} 字符`)
    .refine((v) => !KNOWN_WEAK_SECRETS.has(v), {
      message: `${field} 不得使用占位/弱密钥（如 change-me-*、secret、password）`,
    })
    .refine((v) => new Set(v).size >= 4, {
      message: `${field} 字符多样性过低（至少 4 种不同字符）`,
    });
}

/** 共享环境变量 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/ai_gateway'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

/** OTel（可选，所有服务一致）；默认值在 resolveOtelDefaults 按 NODE_ENV 决定 */
const otelOptions = {
  /**
   * 链路追踪模式：
   *   off=关闭；memory=进程内缓冲+内置 /debug/traces（零基建，开发默认）；
   *   console=每次 span 一行日志；otlp=导出 collector（生产）
   */
  OTEL_TRACES_MODE: z.enum(['off', 'memory', 'console', 'otlp']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
};

/** 未显式设置时：开发/测试默认 memory（零基建可用），生产默认 off */
type OtelTracesMode = 'off' | 'memory' | 'console' | 'otlp';

function resolveOtelDefaults<
  T extends { NODE_ENV: string; OTEL_TRACES_MODE?: string; OTEL_EXPORTER_OTLP_ENDPOINT?: string },
>(parsed: T): Omit<T, 'OTEL_TRACES_MODE'> & { OTEL_TRACES_MODE: OtelTracesMode } {
  const mode = (parsed.OTEL_TRACES_MODE ??
    (parsed.NODE_ENV === 'production' ? 'off' : 'memory')) as OtelTracesMode;
  if (mode === 'otlp' && !parsed.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error('OTEL_TRACES_MODE=otlp 时必须配置 OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  return { ...parsed, OTEL_TRACES_MODE: mode };
}

/** 全局 RPM 生产硬上限（防 .env 残留压测值让全局限流形同虚设） */
export const PROD_GLOBAL_RPM_CAP = 5000;

/** gateway（对外代理）环境变量 */
export const gatewayEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8787),
  /** JWT 签发密钥（网关自签，HS256 起步） */
  JWT_SECRET: secretSchema('JWT_SECRET', 16),
  /** 渠道上游 Key 的 AES-256-GCM 加密密钥 */
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /** 单请求允许授权的最大费用暴露（元）；超过时拒绝，绝不截断。 */
  BILLING_RESERVATION_MAX: z.coerce.number().min(0.000001).default(50),
  /** authorize 后尚未调用上游的安全退款租约。 */
  BILLING_AUTHORIZATION_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  /** 上游在途 lease；长流按周期续租，过期只转 uncertain。 */
  BILLING_LEASE_SECONDS: z.coerce.number().int().min(3).default(60),
  /** Worker 故障时的 DB durable backlog 准入阈值；超过任一阈值停止新增付费请求。 */
  BILLING_PENDING_MAX: z.coerce.number().int().min(1).default(10_000),
  BILLING_PENDING_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(300),
  BILLING_ADMISSION_CACHE_MS: z.coerce.number().int().min(100).default(1_000),
  /** 整个请求跨重试、渠道和 fallback 共享的绝对时间预算。 */
  GATEWAY_REQUEST_DEADLINE_MS: z.coerce.number().int().min(1_000).default(240_000),
  GATEWAY_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(10_000),
  GATEWAY_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  GATEWAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3001')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  /** 全局限流（RPM，多副本合计）。生产环境硬上限 PROD_GLOBAL_RPM_CAP，开发不限制（便于压测）。 */
  GLOBAL_RPM: z.coerce.number().int().min(1).default(2000),
  /** 新用户默认限流（用户级） */
  DEFAULT_USER_RPM: z.coerce.number().int().min(1).default(60),
  DEFAULT_USER_TPM: z.coerce.number().int().min(1).default(1_000_000),
  /** 来源级鉴权失败限流（07）：短窗口内同一来源鉴权失败达阈值即 429 */
  GATEWAY_AUTH_FAILURE_LIMIT: z.coerce.number().int().min(1).default(10),
  GATEWAY_AUTH_FAILURE_WINDOW_S: z.coerce.number().int().min(1).default(60),
  /**
   * 信用模型：单请求输出敞口上限（token）。max_tokens 是「上限」不是「预期」，
   * 敞口估算按 min(max_tokens×n, 本值) 计，超出部分由 credit_limit 透支缓冲兜底。
   */
  GATEWAY_OUTPUT_EXPOSURE_CAP: z.coerce.number().int().min(1).default(32_768),
  /** 本地 /debug/traces 查看页令牌（memory 模式）；未设时仅开发环境放行 */
  DEBUG_TRACES_TOKEN: z.string().min(8).optional(),
  /**
   * 允许 http:// 与内网上游（仅压测/本地调试）。
   * 双重门控：本开关为 true 且 NODE_ENV !== 'production' 才生效（见 gateway createAi）。
   */
  ALLOW_LOCAL_UPSTREAM: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** 生产允许访问的上游域名，逗号分隔；生产必须显式配置，禁止任意可控 DNS。 */
  UPSTREAM_HOST_ALLOWLIST: z
    .string()
    .default(
      'api.openai.com,api.deepseek.com,api.minimax.chat,api.minimaxi.com,open.bigmodel.cn,api.anthropic.com,generativelanguage.googleapis.com',
    )
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ...otelOptions,
});

/** worker（计量结算）环境变量 */
export const workerEnvSchema = baseEnvSchema.extend({
  /** 计量队列并发数 */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  WORKER_INSTANCE_ID: z.string().min(1).optional(),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).default(8792),
  WORKER_CLAIM_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  WORKER_CLAIM_LEASE_MS: z.coerce.number().int().min(1000).default(60_000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
  WORKER_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  WORKER_RETRY_BASE_MS: z.coerce.number().int().min(100).default(2_000),
  WORKER_RETRY_MAX_MS: z.coerce.number().int().min(1000).default(300_000),
  WORKER_MAX_SETTLEMENT_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_LOOP_STALE_MS: z.coerce.number().int().min(1000).default(30_000),
  WORKER_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  /**
   * uncertain 单小额自动放行阈值（元）：白名单失败码（证明上游未计费）无条件放行；
   * 其余 uncertain 预扣 ≤ 此值自动放行（actor=system，全程审计）。'0' 关闭整个通道。
   */
  WORKER_AUTO_RELEASE_MAX_AMOUNT: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'WORKER_AUTO_RELEASE_MAX_AMOUNT 须为非负小数（元）')
    .default('0.1'),
  /** trace_spans 分区保留天数（滚动删除） */
  TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** trace 分区维护间隔（预建未来分区 + 清理超期） */
  WORKER_TRACE_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  ...otelOptions,
});

/** admin-api（管理端 REST）环境变量 */
export const adminApiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8790),
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /**
   * 管理员会话 JWT 密钥（独立于用户面 JWT_SECRET，物理隔离）。
   * 与 client-api 的 JWT_SECRET 必须不同值（隔离要求）。
   */
  ADMIN_JWT_SECRET: secretSchema('ADMIN_JWT_SECRET', 16),
  /** CSRF 受信浏览器来源（逗号分隔），用于状态变更接口的 Origin 校验 */
  CSRF_TRUSTED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3001')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  /** 渠道进货凭证截图本地存储目录（后续可切 OSS） */
  VOUCHER_STORAGE_DIR: z.string().default('./data/vouchers'),
  /**
   * 渠道测试探活放行内网上游（与网关同一双重门控：true 且非生产才生效）。
   */
  ALLOW_LOCAL_UPSTREAM: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** 凭证截图最大字节数（默认 2MB） */
  VOUCHER_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  ...otelOptions,
});

/** client-api（用户面板 REST）环境变量 */
export const clientApiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8791),
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /**
   * 用户面会话 JWT 密钥（独立于管理员 ADMIN_JWT_SECRET，物理隔离）。
   * 用户登录（/api/auth/login）签发会话 JWT 必须有密钥。
   */
  JWT_SECRET: secretSchema('JWT_SECRET', 16),
  /** 新用户赠送额度（元），默认 ¥1（requirements 4.1） */
  GIFT_AMOUNT: z.coerce.number().min(0).default(1),
  /** CSRF 受信浏览器来源（逗号分隔），用于状态变更接口的 Origin 校验 */
  CSRF_TRUSTED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3001')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ...otelOptions,
});

export type GatewayEnv = ReturnType<typeof loadGatewayEnv>;
export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;
/** trace-receiver（链路接收端，内网服务）环境变量 */
export const traceReceiverEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8793),
  /**
   * 接收端共享令牌：设置后所有接口要求 Authorization: Bearer <token>。
   * 生产环境必须设置（fail fast）；开发默认不设（内网放行）。
   */
  TRACE_RECEIVER_TOKEN: z.string().min(16).optional(),
  /** 批量写入阈值（span 数） */
  TRACE_BATCH_MAX: z.coerce.number().int().min(1).default(500),
  /** 刷写间隔（毫秒） */
  TRACE_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
  /** 有界队列上限：满时丢最旧并计数（观测永不反压业务） */
  TRACE_QUEUE_MAX: z.coerce.number().int().min(100).default(10_000),
  ...otelOptions,
});

export type TraceReceiverEnv = ReturnType<typeof loadTraceReceiverEnv>;

export type AdminApiEnv = ReturnType<typeof loadAdminApiEnv>;
export type ClientApiEnv = ReturnType<typeof loadClientApiEnv>;

/** 解析并校验环境变量，失败即抛错（fail fast） */
export function loadGatewayEnv(env = process.env) {
  const parsed = resolveOtelDefaults(gatewayEnvSchema.parse(env));
  if (parsed.NODE_ENV === 'production' && parsed.UPSTREAM_HOST_ALLOWLIST.length === 0) {
    throw new Error('production requires UPSTREAM_HOST_ALLOWLIST');
  }
  // 生产环境强制硬上限；开发/测试不限制（便于压测）
  const globalRpm =
    parsed.NODE_ENV === 'production'
      ? Math.min(parsed.GLOBAL_RPM, PROD_GLOBAL_RPM_CAP)
      : parsed.GLOBAL_RPM;
  return { ...parsed, GLOBAL_RPM: globalRpm };
}

export function loadWorkerEnv(env = process.env) {
  const parsed = resolveOtelDefaults(workerEnvSchema.parse(env));
  if (parsed.WORKER_RETRY_BASE_MS > parsed.WORKER_RETRY_MAX_MS) {
    throw new Error('WORKER_RETRY_BASE_MS must be <= WORKER_RETRY_MAX_MS');
  }
  if (parsed.WORKER_CLAIM_LEASE_MS <= parsed.WORKER_POLL_INTERVAL_MS) {
    throw new Error('WORKER_CLAIM_LEASE_MS must be greater than WORKER_POLL_INTERVAL_MS');
  }
  return parsed;
}

export function loadAdminApiEnv(env = process.env) {
  return resolveOtelDefaults(adminApiEnvSchema.parse(env));
}

export function loadClientApiEnv(env = process.env) {
  return resolveOtelDefaults(clientApiEnvSchema.parse(env));
}

export function loadTraceReceiverEnv(env = process.env) {
  const parsed = resolveOtelDefaults(traceReceiverEnvSchema.parse(env));
  if (parsed.NODE_ENV === 'production' && !parsed.TRACE_RECEIVER_TOKEN) {
    throw new Error('production 环境必须设置 TRACE_RECEIVER_TOKEN（链路接收端鉴权）');
  }
  return parsed;
}
