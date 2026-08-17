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

/** 会话签名密钥长度：生产强制 32 字节（HS256 最佳实践），开发环境 16 可用 */
function sessionSecretSchema(field: string) {
  const minLen = process.env.NODE_ENV === 'production' ? 32 : 16;
  return secretSchema(field, minLen).refine(
    (v: string) => v.length >= minLen,
    { message: `${field} 在生产环境至少 32 字符（当前 HS256 密钥强度要求）` },
  );
}

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
  /** 轮换双 key 窗：旧密钥（仅在轮换期间设置；v1 密文用它解密，收窗后必须移除） */
  ENCRYPTION_KEY_OLD: z.string().min(32).max(256).optional(),
  /** 可信反向代理层数：0=不信任 XFF（默认，直连安全）；nginx 单层部署设 1（右数第 1 跳为真实客户端） */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  PORT: z.coerce.number().int().min(1).default(8787),
  /** JWT 签发密钥（网关自签，HS256 起步） */
  JWT_SECRET: sessionSecretSchema('JWT_SECRET'),
  /** 渠道上游 Key 的 AES-256-GCM 加密密钥 */
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /** 单请求允许授权的最大费用暴露（元）；超过时拒绝，绝不截断。 */
  BILLING_RESERVATION_MAX: z.coerce.number().min(0.000001).default(50),
  /** authorize 后尚未调用上游的安全退款租约。 */
  BILLING_AUTHORIZATION_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  /** 上游在途 lease；长流按周期续租，网关崩溃过期由 recoverOnce 释放（gateway_crash_released）。 */
  BILLING_LEASE_SECONDS: z.coerce.number().int().min(3).default(60),
  /** Worker 故障时的 DB durable backlog 准入阈值；超过任一阈值停止新增付费请求。 */
  BILLING_PENDING_MAX: z.coerce.number().int().min(1).default(10_000),
  BILLING_PENDING_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(300),
  BILLING_ADMISSION_CACHE_MS: z.coerce.number().int().min(100).default(1_000),
  /** 整个请求跨重试、渠道和 fallback 共享的绝对时间预算。 */
  GATEWAY_REQUEST_DEADLINE_MS: z.coerce.number().int().min(1_000).default(240_000),
  /**
   * 优雅停机宽限（SIGTERM → 强制退出的总窗口，应 ≤ k8s terminationGracePeriodSeconds）。
   * 语义：停机即拒新请求；宽限期结束前 5s 以 ServerDrainAbort 中止在途请求
   * （服务端责任全额释放），宽限期到强制退出。
   */
  GATEWAY_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(6_000).default(30_000),
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
  /** 免费模型每用户每日请求上限（0 元授权不计每日花费上限，需独立闸防滥用）；0=不限制 */
  FREE_MODEL_DAILY_LIMIT: z.coerce.number().int().min(0).default(500),
  DEFAULT_USER_TPM: z.coerce.number().int().min(1).default(1_000_000),
  /** 来源级鉴权失败限流（07）：短窗口内同一来源鉴权失败达阈值即 429 */
  GATEWAY_AUTH_FAILURE_LIMIT: z.coerce.number().int().min(1).default(10),
  GATEWAY_AUTH_FAILURE_WINDOW_S: z.coerce.number().int().min(1).default(60),
  /**
   * 信用模型：单请求输出敞口上限（token）。max_tokens 是「上限」不是「预期」，
   * 敞口估算按 min(max_tokens×n, 本值) 计，超出部分由 credit_limit 透支缓冲兜底。
   */
  GATEWAY_OUTPUT_EXPOSURE_CAP: z.coerce.number().int().min(1).default(32_768),
  /** 异步生成任务（video/music）生命周期上界（秒）：提交时写 generation_tasks.expires_at，
   *  billing 租约与 worker 超时扫描共用该值——任务要么在 TTL 内终态结算，要么按 expired 释放。 */
  GENERATION_TASK_TTL_SECONDS: z.coerce.number().int().min(60).default(1_800),
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
const smtpEnvSchema = {
  SMTP_HOST: z.string().max(255).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().max(255).optional(),
  /** 邮箱授权码（非登录密码；QQ/163 在设置-账户中生成） */
  SMTP_PASS: z.string().max(255).optional(),
  SMTP_FROM: z.string().max(255).optional(),
};

export const workerEnvSchema = baseEnvSchema.extend({
  ...smtpEnvSchema,
  /** 渠道 Key 解密（generation poller 调上游用；与 gateway 同源） */
  ENCRYPTION_KEY_OLD: z.string().min(32).max(256).optional(),
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /** 上游调用面（generation poller 的 music 代执行/任务查询用；与 gateway 同源语义） */
  ALLOW_LOCAL_UPSTREAM: z
    .boolean()
    .default(false)
    .describe('允许 http:// 上游（仅本地 mock；生产强制 false）'),
  UPSTREAM_HOST_ALLOWLIST: z.array(z.string()).default([]),
  /** 邀请人佣金比例（与 client-api 同源语义：被邀请人日消费 × 比例） */
  REFERRAL_COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.1),
  /** 计量队列并发数 */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  /** 上游在途 lease（与网关同源：小额自动放行的最小滞留下界取一个租约周期） */
  BILLING_LEASE_SECONDS: z.coerce.number().int().min(3).default(60),
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
  /** 邀请佣金日结间隔（默认 6h——幂等键按日，重复运行安全） */
  WORKER_REFERRAL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(6 * 3600_000),
  /** 告警通知投递轮询间隔 */
  WORKER_NOTIFY_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** 异步生成任务轮询（video 状态查询 + music 代执行 + 续租 + 超时扫描） */
  WORKER_GENERATION_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  /** 单轮任务轮询的批量上界 */
  WORKER_GENERATION_BATCH: z.coerce.number().int().min(1).default(50),
  /** trace_spans 分区保留天数（滚动删除） */
  TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** request_logs 月分区保留窗口（滚动删除更早分区）；30 = data-model §3.13 承诺 */
  REQUEST_LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
  /** trace 分区维护间隔（预建未来分区 + 清理超期） */
  WORKER_TRACE_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  ...otelOptions,
});

/** 发信 SMTP（登录邮箱验证码；admin 2FA 与 client 强制验证共用）。三要素齐全才启用 */

/** admin-api（管理端 REST）环境变量 */
export const adminApiEnvSchema = baseEnvSchema.extend({
  ...smtpEnvSchema,
  /** 轮换双 key 窗：旧密钥（仅在轮换期间设置；v1 密文用它解密，收窗后必须移除） */
  ENCRYPTION_KEY_OLD: z.string().min(32).max(256).optional(),
  /** BFF 服务间令牌：配置后 Origin/Referer 双缺失请求必须携带 x-internal-token（CSRF fail-closed） */
  INTERNAL_API_TOKEN: z.string().min(16).max(128).optional(),
  /** 可信反向代理层数：0=不信任 XFF（默认，直连安全）；nginx 单层部署设 1（右数第 1 跳为真实客户端） */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  PORT: z.coerce.number().int().min(1).default(8790),
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /**
   * 管理员会话 JWT 密钥（独立于用户面 JWT_SECRET，物理隔离）。
   * 与 client-api 的 JWT_SECRET 必须不同值（隔离要求）。
   */
  ADMIN_JWT_SECRET: sessionSecretSchema('ADMIN_JWT_SECRET'),
  /** CSRF 受信浏览器来源（逗号分隔），用于状态变更接口的 Origin 校验。
   *  默认含管理面板自身端口 3002（apps/admin dev/start 固定 -p 3002）——
   *  原默认漏掉 3002，浏览器登录全部 CSRF_ORIGIN_DENIED。 */
  CSRF_TRUSTED_ORIGINS: z
    .string()
    .default('http://localhost:3002,http://localhost:3000')
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
  ...smtpEnvSchema,
  /** BFF 服务间令牌：配置后 Origin/Referer 双缺失请求必须携带 x-internal-token（CSRF fail-closed） */
  INTERNAL_API_TOKEN: z.string().min(16).max(128).optional(),
  /** 可信反向代理层数：0=不信任 XFF（默认，直连安全）；nginx 单层部署设 1（右数第 1 跳为真实客户端） */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  PORT: z.coerce.number().int().min(1).default(8791),
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /**
   * 用户面会话 JWT 密钥（独立于管理员 ADMIN_JWT_SECRET，物理隔离）。
   * 用户登录（/api/auth/login）签发会话 JWT 必须有密钥。
   */
  JWT_SECRET: sessionSecretSchema('JWT_SECRET'),
  /** 新用户赠送额度（元），默认 ¥1（requirements 4.1） */
  GIFT_AMOUNT: z.coerce.number().min(0).default(0),
  /** ── OAuth 社交登录（可选；client 对未配置的 provider 隐藏入口）── */
  OAUTH_GITHUB_CLIENT_ID: z.string().max(255).optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().max(255).optional(),
  OAUTH_GOOGLE_CLIENT_ID: z.string().max(255).optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().max(255).optional(),
  /** ── 邀请返利 ── */
  /** 受邀注册双方奖励（元/人；0=关闭） */
  REFERRAL_SIGNUP_BONUS: z.coerce.number().min(0).default(0),
  /** 邀请人佣金比例（被邀请人日消费额 × 比例；0=关闭） */
  REFERRAL_COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0.1),
  /** ── Playground（网关 JWT 桥；成组配置即启用，缺省 = Playground 关闭）── */
  GATEWAY_URL: z.string().url().max(255).optional(),
  /** 与网关 JWT_SECRET 同值（Playground 替用户现签 5 分钟短期 JWT） */
  GATEWAY_JWT_SECRET: z.string().min(16).max(256).optional(),
  /** ── 在线支付（可选；成组配置即启用对应渠道，缺省 = 渠道关闭）── */
  /** 易支付：商户 PID + 密钥 + 网关提交地址 */
  EPAY_PID: z.string().min(1).max(64).optional(),
  EPAY_KEY: z.string().min(16).max(128).optional(),
  EPAY_GATEWAY_URL: z.string().url().max(255).optional(),
  /** 支付回调/回跳地址（两渠道共用，默认按 CLIENT_PUBLIC_ORIGIN 拼） */
  CLIENT_PUBLIC_ORIGIN: z.string().url().max(255).optional(),
  /** Stripe：Secret Key + Webhook 签名密钥 */
  STRIPE_SECRET_KEY: z.string().min(16).max(255).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(16).max(255).optional(),
  /**
   * ── 注册面人机验证（Turnstile，可选；成对配置即启用——只配一半在启动装配时抛错）。
   * 生产暴露自助注册时必须配置：防分布式刷号薅首登赠额。本地开发可用官方测试键：
   * siteKey 1x00000000000000000000AA / secretKey 1x0000000000000000000000000000000AA（恒过）。
   */
  CAPTCHA_SITE_KEY: z.string().min(1).max(255).optional(),
  CAPTCHA_SECRET_KEY: z.string().min(1).max(255).optional(),
  /**
   * 邮箱自助注册开关（默认开）。关闭 = 只留 GitHub/Google OAuth 建号（身份锚点外包
   * 给平台方），存量邮箱账号登录不受影响。赠额套利压力大时的运营闸门。
   */
  REGISTER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** OAuth 登录完成后重定向回的前端地址（默认本地面板） */
  OAUTH_FRONTEND_URL: z.string().url().default('http://localhost:3001'),
  /** 本服务对外可达基地址（拼 OAuth redirect_uri；默认本地 8791） */
  OAUTH_API_BASE: z.string().url().default('http://localhost:8791'),
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
  const parsed = adminApiEnvSchema.parse(env);
  // 双面密钥物理隔离：同值会让隔离退化为仅靠 iss+type 声明——配置期直接拒绝
  if (env.JWT_SECRET && env.JWT_SECRET === parsed.ADMIN_JWT_SECRET) {
    throw new Error('ADMIN_JWT_SECRET 不得与 JWT_SECRET 同值（双身份面必须物理隔离）');
  }
  return resolveOtelDefaults(parsed);
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
