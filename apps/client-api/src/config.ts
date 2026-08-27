/**
 * 环境配置（zod 解析，装配唯一入口）：部署可变值全在此声明——
 * 业务参数（开关/阈值/密钥）必填或显式默认，代码零写死。
 * 键覆盖 identity 装配面（CODE_PEPPER/挑战参数/密码策略）与
 * 新机制件（EPAY_PAY_TYPE/用量时区/定价缓存）所需。
 */
import * as z from 'zod';
import { secretSchema, strictBooleanSchema } from '@tillgate/runtime';
import { Decimal } from '@tillgate/billing';

const nonNegativeDecimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);
const positiveDecimal = nonNegativeDecimal.refine((value) => !/^0+(?:\.0+)?$/.test(value));

// eslint-disable-next-line max-lines-per-function -- env zod schema 定义平铺(逐键声明即数据)
function createSchema(production: boolean) {
  return z.object({
    /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    /** 运行形态（经 zod 运行期解析消费——直读 process.env.NODE_ENV 会被 bun build 构建期内联） */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
    /** 密码策略下界（缺省 10；上界 128 固定——identity 域校验） */
    CLIENT_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(6).max(128).default(10),
    /** 邮箱验证码挑战：有效期/发送冷却/最大尝试次数 */
    CLIENT_CHALLENGE_TTL_MS: z.coerce.number().int().positive().default(600_000),
    CLIENT_CHALLENGE_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
    CLIENT_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(10),
    /** TOTP（MFA 预留词表；用户面暂不开放端点——identity 配置必填项） */
    CLIENT_TOTP_ISSUER: z.string().min(1).max(255).default('Tillgate'),
    /** 邮箱自助注册开关（关闭只留既有账号登录） */
    REGISTER_ENABLED: strictBooleanSchema(true),
    /** 同 IP 注册请求窗口（秒）与上限/窗口（防批量刷号；窗口即 Retry-After 口径） */
    REGISTER_IP_WINDOW_SECONDS: z.coerce.number().int().positive().default(3_600),
    REGISTER_IP_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
    /** 兑换频率闸：每用户每分钟兑换尝试上限（防暴力猜码） */
    REDEEM_PER_MINUTE_LIMIT: z.coerce.number().int().positive().default(10),
    /** 充值下单频率闸：每用户每分钟下单上限 */
    CLIENT_TOPUP_ORDERS_PER_MINUTE: z.coerce.number().int().positive().default(10),
    /** 登录爆破防护：per-邮箱+IP 失败阈值/窗口/锁定 + per-IP 失败上限（秒窗口即锁时长） */
    LOGIN_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(10),
    LOGIN_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(600),
    LOGIN_LOCK_S: z.coerce.number().int().positive().default(600),
    LOGIN_IP_FAILURE_LIMIT: z.coerce.number().int().positive().default(50),
    LOGIN_IP_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(300),
    /** 可信代理跳数（来源 IP 提取语义：0 = 不信 XFF） */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    /** CORS 白名单（逗号分隔；空 = 不放行跨域）与预检缓存秒数 */
    CORS_ORIGINS: z.string().default(''),
    /**
     * OAuth 基地址（env 来源——部署拓扑，装配期生效变更需重启）：
     * API 根地址生产必填（回调白名单由它构建）；前端根地址可选，
     * 未配回落本地缺省、且找回密码链接 fail-closed（不外发错误域名链接）。
     */
    OAUTH_API_BASE: z.string().url().optional(),
    OAUTH_FRONTEND_URL: z.string().url().optional(),
    CLIENT_CORS_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(600),
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
    // 支付渠道凭据（EPAY/STRIPE）在 integration_settings（动态配置）
    /** 邮箱验证码两级登录：auto = smtp 集成行生效即强制 / on 强制 / off 关闭（单密码） */
    EMAIL_CODE_REQUIRED: z.enum(['auto', 'on', 'off']).default('auto'),
    // SMTP/CAPTCHA/OAuth 凭据在 integration_settings（动态配置）；
    // 本 schema 只留端点覆盖与 TTL
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
      .default('sk_'),
    /** accounts 装配 policy（邀请有效期/待接受上限因子与上界/Key 限额上界） */
    CLIENT_INVITATION_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 3600 * 1000),
    CLIENT_INVITATION_PENDING_FACTOR: z.coerce.number().int().positive().default(2),
    CLIENT_INVITATION_PENDING_CAP: z.coerce.number().int().positive().default(20),
    CLIENT_RPM_LIMIT_MAX: z.coerce.number().int().positive().default(1_000_000),
    CLIENT_TPM_LIMIT_MAX: z.coerce.number().int().positive().default(100_000_000),
    /** 推荐被邀名单上界（referralOverview invitees 截断） */
    CLIENT_REFERRAL_INVITEE_LIMIT: z.coerce.number().int().positive().default(100),
    /** 用量日汇总的日界时区（缺省北京时间；GROUP BY 需字面量——字符白名单校验防注入） */
    CLIENT_USAGE_TZ: z
      .string()
      .regex(/^[A-Za-z0-9_+/-]{1,64}$/, 'invalid IANA timezone shape')
      .default('Asia/Shanghai'),
    /** 公开定价目录共享缓存 TTL（ms；redis 多副本一份） */
    PRICING_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
    /** 计费时区 KV 读取的进程内缓存（低频变更；与网关 BILLING_TIMEZONE_TTL_MS 同语义） */
    BILLING_TIMEZONE_TTL_MS: z.coerce.number().int().min(1_000).default(60_000),
    /** system_configs 未配置 billing_timezone 时的回落（与网关同缺省） */
    BILLING_TIMEZONE_DEFAULT: z.string().default('Asia/Shanghai'),
    /** 结算失败策略（billing 注入；worker 侧同源语义） */
    CLIENT_SETTLE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
    CLIENT_SETTLE_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
    CLIENT_SETTLE_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
    /** DB 事务重试 */
    CLIENT_TX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    CLIENT_TX_BASE_DELAY_MS: z.coerce.number().int().min(0).default(15),
    CLIENT_TX_MAX_JITTER_MS: z.coerce.number().int().min(0).default(20),
    /** OTel：off 完全 no-op / otlp 走 collector */
    OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    /** OTLP 推送鉴权(Bearer)——与 trace-receiver 共用同键同值;缺此值对生产接收端 = span 全部 401 拒收 */
    TRACE_RECEIVER_TOKEN: z.string().min(1).optional(),
    OTEL_METRICS_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    /** Redis 告警日志节流与启动连通性探测超时（ms） */
    CLIENT_REDIS_LOG_THROTTLE_MS: z.coerce.number().int().positive().default(60_000),
    CLIENT_STARTUP_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
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

/** 端点覆盖解析（JSON：私有化/E2E mock 上游用；非法 JSON fail-loud） */
function parseEndpoints(json: string | undefined, provider: string) {
  if (!json) return;
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
  if (production && parsed.OAUTH_API_BASE == null) {
    throw new Error('OAUTH_API_BASE is required in production (OAuth redirect allowlist)');
  }
  parseEndpoints(parsed.OAUTH_GITHUB_ENDPOINTS_JSON, 'github');
  parseEndpoints(parsed.OAUTH_GOOGLE_ENDPOINTS_JSON, 'google');
  // captcha 成对校验
  // smtp 三要素成组
  // sentinel 拓扑：配置了节点列表必须带主名（runtime RedisClientOptions 判别联合）
  if (parsed.REDIS_SENTINELS != null && !parsed.REDIS_SENTINEL_NAME) {
    throw new Error('REDIS_SENTINEL_NAME is required when REDIS_SENTINELS is configured');
  }
  return parsed;
}
