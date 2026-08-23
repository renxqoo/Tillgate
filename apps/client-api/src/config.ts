/**
 * 环境配置（zod 解析，装配唯一入口）：部署可变值全在此声明——
 * 业务参数（开关/阈值/密钥）必填或显式默认，代码零写死（铁律 3）。
 * v1 键名全量保留；新增键为 identity 装配面（CODE_PEPPER/挑战参数/密码策略）与
 * 新机制件（EPAY_PAY_TYPE/用量时区/定价缓存）所需。
 */
import { z } from 'zod';
import { secretSchema, strictBooleanSchema } from '@tokenlens/runtime';
import { Decimal, EPAY_PAY_TYPES } from '@tokenlens/billing';

const nonNegativeDecimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);
const positiveDecimal = nonNegativeDecimal.refine((value) => !/^0+(?:\.0+)?$/.test(value));

function createSchema(production: boolean) {
  return z.object({
    /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    CLIENT_API_PORT: z.coerce.number().int().positive().default(8081),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    CLIENT_DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    CLIENT_DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    CLIENT_DB_MAX_USES: z.coerce.number().int().positive().default(1_000),
    /** 记账币种（billing guards 注入；充值/赠送/订阅同一口径） */
    CLIENT_CURRENCY: z.string().default('CNY'),
    /** 用户面会话 JWT 密钥（与管理面、网关 App JWT 物理隔离） */
    JWT_SECRET: secretSchema('JWT_SECRET', production ? 32 : 16),
    /** 会话有效期（秒） */
    SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(86_400),
    /** 邮箱验证码 HMAC pepper（identity 挑战域防离线穷举；与 JWT 密钥分离） */
    CLIENT_CODE_PEPPER: secretSchema('CLIENT_CODE_PEPPER', production ? 32 : 16),
    /** 密码策略下界（v1 口径 10；上界 128 固定——identity 域校验） */
    CLIENT_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(6).max(128).default(10),
    /** 邮箱验证码挑战：有效期/发送冷却/最大尝试次数 */
    CLIENT_CHALLENGE_TTL_MS: z.coerce.number().int().positive().default(600_000),
    CLIENT_CHALLENGE_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
    CLIENT_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    /** TOTP（MFA 预留词表；用户面暂不开放端点——identity 配置必填项） */
    CLIENT_TOTP_ISSUER: z.string().min(1).max(255).default('TokenLens'),
    /** 邮箱自助注册开关（关闭只留既有账号登录） */
    REGISTER_ENABLED: strictBooleanSchema(true),
    /** 同 IP 注册请求上限/小时（防批量刷号） */
    REGISTER_IP_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
    /** 兑换频率闸：每用户每分钟兑换尝试上限（防暴力猜码） */
    REDEEM_PER_MINUTE_LIMIT: z.coerce.number().int().positive().default(10),
    /** 充值下单频率闸：每用户每分钟下单上限 */
    CLIENT_TOPUP_ORDERS_PER_MINUTE: z.coerce.number().int().positive().default(10),
    /** 登录爆破防护：per-邮箱+IP 失败阈值/窗口/锁定 + per-IP 失败上限（秒窗口即锁时长） */
    LOGIN_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    LOGIN_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(600),
    LOGIN_LOCK_S: z.coerce.number().int().positive().default(600),
    LOGIN_IP_FAILURE_LIMIT: z.coerce.number().int().positive().default(50),
    LOGIN_IP_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(300),
    /** 可信代理跳数（来源 IP 提取语义：0 = 不信 XFF） */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    /** CORS 白名单（逗号分隔；空 = 不放行跨域） */
    CORS_ORIGINS: z.string().default(''),
    /** 请求体上限（字节） */
    CLIENT_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024),
    /** 充值面额闸：单笔下限/上限（元）与入账汇率（creditAmount = amount × 汇率） */
    TOPUP_MIN: positiveDecimal.default('1'),
    TOPUP_MAX: positiveDecimal.default('100000'),
    TOPUP_EXCHANGE_RATE: positiveDecimal.default('1'),
    /** 未支付订单超时关单（ms） */
    PAYMENT_ORDER_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
    /** 易支付五件套全配才启用该渠道；PAY_TYPE 从词表校验（不写死 alipay） */
    EPAY_PID: z.string().optional(),
    EPAY_KEY: z.string().optional(),
    EPAY_GATEWAY_URL: z.string().url().optional(),
    EPAY_NOTIFY_URL: z.string().url().optional(),
    EPAY_RETURN_URL: z.string().url().optional(),
    EPAY_PAY_TYPE: z
      .string()
      .refine((v) => (EPAY_PAY_TYPES as readonly string[]).includes(v), 'unsupported epay pay type')
      .default('alipay'),
    /** Stripe（国际卡）四件套全配才启用该渠道（Checkout Session + webhook 验签） */
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_SUCCESS_URL: z.string().url().optional(),
    STRIPE_CANCEL_URL: z.string().url().optional(),
    /** API 基地址覆盖（默认官方 api.stripe.com；私有化网关/测试 mock 上游用） */
    STRIPE_API_BASE: z.string().url().optional(),
    /** 邮箱验证码两级登录：auto = SMTP 已配置即强制 / on 强制 / off 关闭（单密码） */
    EMAIL_CODE_REQUIRED: z.enum(['auto', 'on', 'off']).default('auto'),
    /** SMTP 三要素（host/user/pass）齐全才启用发信；未配置 = 验证码模式不可用（fail-closed） */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    /** 人机验证（Turnstile）：siteKey/secretKey 成对配置才启用；只配一半 = 启动失败 */
    CAPTCHA_SITE_KEY: z.string().optional(),
    CAPTCHA_SECRET_KEY: z.string().optional(),
    /** siteverify 端点（默认官方；私有化代理/测试 mock 覆盖） */
    CAPTCHA_VERIFY_URL: z.string().url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
    /** OAuth 社交登录（GitHub/Google）：前后端基地址 + 各 provider 凭证（未配 = 404/按钮隐藏） */
    OAUTH_FRONTEND_URL: z.string().url().optional(),
    OAUTH_API_BASE: z.string().url().optional(),
    OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
    OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
    /** 端点覆盖（JSON：authorizeUrl/tokenUrl/profileUrl/emailsUrl——私有化/测试 mock 用） */
    OAUTH_GITHUB_ENDPOINTS_JSON: z.string().optional(),
    OAUTH_GOOGLE_ENDPOINTS_JSON: z.string().optional(),
    /** OAuth state 单次存储 TTL（秒）——cookie 与 redis 同步寿命 */
    OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    /** 生产 Cookie 加 Secure（OAuth state cookie） */
    SECURE_COOKIE: strictBooleanSchema(production),
    /** 优雅停机：停收新请求后等待在途完成的上界（ms） */
    CLIENT_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
    /** 虚拟 Key 前缀（与网关识别端共用同一 env；自定义仅限新实例首次部署） */
    KEY_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,15}$/)
      .default('ag_'),
    /** accounts 装配 policy（邀请有效期/待接受上限因子与上界/Key 限额上界） */
    CLIENT_INVITATION_TTL_MS: z.coerce.number().int().positive().default(7 * 24 * 3600 * 1000),
    CLIENT_INVITATION_PENDING_FACTOR: z.coerce.number().int().positive().default(2),
    CLIENT_INVITATION_PENDING_CAP: z.coerce.number().int().positive().default(20),
    CLIENT_RPM_LIMIT_MAX: z.coerce.number().int().positive().default(1_000_000),
    CLIENT_TPM_LIMIT_MAX: z.coerce.number().int().positive().default(100_000_000),
    /** 推荐被邀名单上界（referralOverview invitees 截断） */
    CLIENT_REFERRAL_INVITEE_LIMIT: z.coerce.number().int().positive().default(100),
    /** 用量日汇总的日界时区（v1 口径北京时间；SQL 参数化注入不写死） */
    CLIENT_USAGE_TZ: z.string().min(1).default('Asia/Shanghai'),
    /** 公开定价目录共享缓存 TTL（ms；redis 多副本一份） */
    PRICING_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
    /** 结算失败策略（billing 注入；worker 侧同源语义） */
    CLIENT_SETTLE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
    CLIENT_SETTLE_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
    CLIENT_SETTLE_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
    /** DB 事务重试（v1 等价口径） */
    CLIENT_TX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    CLIENT_TX_BASE_DELAY_MS: z.coerce.number().int().min(0).default(15),
    CLIENT_TX_MAX_JITTER_MS: z.coerce.number().int().min(0).default(20),
    /** OTel：off 完全 no-op / otlp 走 collector */
    OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    /** 日志级别 */
    LOG_LEVEL: z.string().default('info'),
    /** 运行时对称加密根密钥（密码信封复用——渠道 Key 加密同源，轮换走双 key 窗） */
    ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', production ? 32 : 16),
    /** Redis Sentinel 拓扑（可选；配置后覆盖直连形态） */
    REDIS_SENTINELS: z.string().optional(),
    REDIS_SENTINEL_NAME: z.string().optional(),
    REDIS_SENTINEL_PASSWORD: z.string().optional(),
  });
}

export type ClientApiConfig = z.infer<ReturnType<typeof createSchema>>;

/** 全配返回 true；全空返回 false；半配抛错（fail-closed——半配 = 静默坏流） */
function assertGroup(name: string, values: Array<unknown>): boolean {
  if (values.every((v) => !v)) return false;
  if (values.some((v) => !v)) {
    throw new Error(`${name} options must be configured as a group`);
  }
  return true;
}

/** 端点覆盖解析（JSON：私有化/E2E mock 上游用；非法 JSON fail-loud） */
function parseEndpoints(json: string | undefined, provider: string) {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as {
      authorizeUrl?: string;
      tokenUrl?: string;
      profileUrl?: string;
      emailsUrl?: string;
    };
  } catch {
    throw new Error(`OAUTH_${provider.toUpperCase()}_ENDPOINTS_JSON is not valid JSON`);
  }
}

export function loadClientApiConfig(env: NodeJS.ProcessEnv = process.env): ClientApiConfig {
  const production = env.NODE_ENV === 'production';
  const parsed = createSchema(production).parse(env);

  if (new Decimal(parsed.TOPUP_MIN).gt(parsed.TOPUP_MAX)) {
    throw new Error('TOPUP_MIN must not be greater than TOPUP_MAX');
  }
  if (production && !parsed.SECURE_COOKIE) {
    throw new Error('SECURE_COOKIE must be enabled in production');
  }
  // 支付渠道组配置全-or-无（半配 = 配置错误，直接抛）
  assertGroup(
    'EPAY_*',
    [parsed.EPAY_PID, parsed.EPAY_KEY, parsed.EPAY_GATEWAY_URL, parsed.EPAY_NOTIFY_URL, parsed.EPAY_RETURN_URL],
  );
  assertGroup(
    'STRIPE_*',
    [parsed.STRIPE_SECRET_KEY, parsed.STRIPE_WEBHOOK_SECRET, parsed.STRIPE_SUCCESS_URL, parsed.STRIPE_CANCEL_URL],
  );
  // OAuth：凭证与前后端基地址成组（有凭证必须有跳转面；全无 = 关闭社交登录）
  const oauthCredentialed =
    Boolean(parsed.OAUTH_GITHUB_CLIENT_ID || parsed.OAUTH_GOOGLE_CLIENT_ID);
  if (oauthCredentialed && !(parsed.OAUTH_FRONTEND_URL && parsed.OAUTH_API_BASE)) {
    throw new Error(
      'OAUTH_FRONTEND_URL and OAUTH_API_BASE must be configured together with OAuth credentials',
    );
  }
  if (parsed.OAUTH_FRONTEND_URL && !parsed.OAUTH_API_BASE) {
    throw new Error('OAUTH_API_BASE must be configured together with OAUTH_FRONTEND_URL');
  }
  // 预解析端点覆盖（非法 JSON fail-loud 在启动期而非首跳期）
  parseEndpoints(parsed.OAUTH_GITHUB_ENDPOINTS_JSON, 'github');
  parseEndpoints(parsed.OAUTH_GOOGLE_ENDPOINTS_JSON, 'google');
  // captcha 成对校验
  assertGroup('CAPTCHA_*', [parsed.CAPTCHA_SITE_KEY, parsed.CAPTCHA_SECRET_KEY]);
  // smtp 三要素成组
  assertGroup('SMTP_*', [parsed.SMTP_HOST, parsed.SMTP_USER, parsed.SMTP_PASS]);
  // sentinel 拓扑：配置了节点列表必须带主名（runtime RedisClientOptions 判别联合）
  if (parsed.REDIS_SENTINELS != null && !parsed.REDIS_SENTINEL_NAME) {
    throw new Error('REDIS_SENTINEL_NAME is required when REDIS_SENTINELS is configured');
  }
  return parsed;
}
