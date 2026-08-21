/**
 * 环境配置（zod 解析，装配唯一入口）：部署可变值全在此声明——
 * 业务参数（开关/阈值/密钥）必填或显式默认，代码零写死。
 */
import { z } from 'zod';
import { secretSchema, strictBooleanSchema } from '@ai-gateway/core';
import { Decimal } from '@ai-gateway/domain';

const nonNegativeDecimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);
const positiveDecimal = nonNegativeDecimal.refine((value) => !/^0+(?:\.0+)?$/.test(value));

function createSchema(production: boolean) {
  return z.object({
  /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8081),
  /** DB 连接池上限 */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** 记账币种（wallet 装配注入；充值/赠送同一口径） */
  CLIENT_CURRENCY: z.string().default('CNY'),
  /** 用户面会话 JWT 密钥（与网关 App JWT、管理面密钥物理隔离） */
  JWT_SECRET: secretSchema('JWT_SECRET', production ? 32 : 16),
  /** 会话有效期（秒） */
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** 邮箱自助注册开关（关闭只留既有账号登录） */
  REGISTER_ENABLED: strictBooleanSchema(true),
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
  TOPUP_MIN: positiveDecimal.default('1'),
  TOPUP_MAX: positiveDecimal.default('100000'),
  TOPUP_EXCHANGE_RATE: positiveDecimal.default('1'),
  /** 未支付订单超时关单（ms） */
  PAYMENT_ORDER_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
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
  SECURE_COOKIE: strictBooleanSchema(production),
  /** 优雅停机：停收新请求后等待在途完成的上界（ms） */
  CLIENT_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
  /** OTel：off 完全 no-op / otlp 走 collector */
  OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  });
}

export type ClientApiConfig = z.infer<ReturnType<typeof createSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientApiConfig {
  const production = env.NODE_ENV === 'production';
  const parsed = createSchema(production).parse(env);
  if (new Decimal(parsed.TOPUP_MIN).gt(parsed.TOPUP_MAX)) {
    throw new Error('TOPUP_MIN must not be greater than TOPUP_MAX');
  }
  if (production && !parsed.SECURE_COOKIE) {
    throw new Error('SECURE_COOKIE must be enabled in production');
  }
  // 废弃键检测（2026-08-21 黑盒子清除）：残留配置静默失效变显式告警
  for (const deprecated of ['MAX_KEYS_PER_USER', 'MAX_APPS_PER_USER']) {
    if (env[deprecated] != null && env[deprecated] !== '') {
      console.warn(`[client-api] 配置项 ${deprecated} 已废弃（数量上限无隐藏默认——需要限制时在服务层显式实现），当前值被忽略`);
    }
  }
  return parsed;
}
