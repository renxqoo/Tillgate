/**
 * 环境配置（zod 解析，装配唯一入口）：部署可变值全在此声明——
 * 业务参数（开关/阈值/密钥）必填或显式默认，代码零写死。
 */
import { z } from 'zod';

const schema = z.object({
  /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8081),
  /** DB 连接池上限 */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** 记账币种（wallet 装配注入；充值/赠送同一口径） */
  CLIENT_CURRENCY: z.string().default('CNY'),
  /** 用户面会话 JWT 密钥（与网关 App JWT、管理面密钥物理隔离） */
  JWT_SECRET: z.string().min(16),
  /** 会话有效期（秒） */
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** 邮箱自助注册开关（关闭只留既有账号登录） */
  REGISTER_ENABLED: z.coerce.boolean().default(true),
  /** 新用户赠送额度（元，字符串金额；'0' = 关闭——开源注册无赠送即无薅羊毛收益） */
  GIFT_AMOUNT: z.string().default('0'),
  /** 单用户在用 Key 上限（配额闸） */
  MAX_KEYS_PER_USER: z.coerce.number().int().positive().default(100),
  /** 每用户 App 数上限（v1 对位——无闸可无限建 App 蹭免费额度语义位） */
  MAX_APPS_PER_USER: z.coerce.number().int().positive().default(100),
  /** 同 IP 注册请求上限/小时（防批量刷号；Redis 形态生效，缺省开发形态不限） */
  REGISTER_IP_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
  /** 兑换频率闸：每用户每分钟兑换尝试上限（防暴力猜码） */
  REDEEM_PER_MINUTE_LIMIT: z.coerce.number().int().positive().default(10),
  /** 登录爆破防护：per-邮箱 失败阈值/窗口/锁定 + per-IP 失败上限（秒窗口即锁时长） */
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
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  /** 充值面额闸：单笔下限/上限（元）与入账汇率（creditAmount = amount × 汇率） */
  TOPUP_MIN: z.string().default('1'),
  TOPUP_MAX: z.string().default('100000'),
  TOPUP_EXCHANGE_RATE: z.string().default('1'),
  /** 未支付订单超时关单（ms） */
  PAYMENT_ORDER_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  /** 操练场（控制台对话调试）：网关地址 + 网关 JWT 密钥成组配置才启用；未配 = 503 */
  PLAYGROUND_GATEWAY_URL: z.string().url().optional(),
  PLAYGROUND_GATEWAY_JWT_SECRET: z.string().min(16).optional(),
  /** 邀请返利：注册双方奖励（元，字符串；'0' = 关闭）；佣金比例（0–1，worker 日结同值） */
  REFERRAL_SIGNUP_BONUS: z.string().default('0'),
  REFERRAL_COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0),
  /** 易支付（epay）四件套全配才启用该渠道；未配置 = 在线充值关闭 */
  EPAY_PID: z.string().optional(),
  EPAY_KEY: z.string().optional(),
  EPAY_GATEWAY_URL: z.string().url().optional(),
  EPAY_NOTIFY_URL: z.string().url().optional(),
  EPAY_RETURN_URL: z.string().url().optional(),
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
  /** OAuth 社交登录（GitHub/Google）：前后端基地址 + 各 provider 凭证（未配 = 404/按钮隐藏） */
  OAUTH_FRONTEND_URL: z.string().url().optional(),
  OAUTH_API_BASE: z.string().url().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** 端点覆盖（JSON：authorizeUrl/tokenUrl/profileUrl/emailsUrl——私有化网关/测试 mock 用） */
  OAUTH_GITHUB_ENDPOINTS_JSON: z.string().optional(),
  OAUTH_GOOGLE_ENDPOINTS_JSON: z.string().optional(),
  /** 生产 Cookie 加 Secure（OAuth state cookie） */
  SECURE_COOKIE: z.coerce.boolean().default(false),
  /** 优雅停机：停收新请求后等待在途完成的上界（ms） */
  CLIENT_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
  /** OTel：off 完全 no-op / otlp 走 collector */
  OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type ClientApiConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientApiConfig {
  return schema.parse(env);
}
