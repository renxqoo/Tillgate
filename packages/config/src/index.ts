import { z } from 'zod';

/**
 * B3 修复：密钥强度校验。
 * 原实现仅校验长度，导致 .env.example 的占位值 `change-me-32-chars-minimum-secret`
 * 能通过校验 → 照抄部署 = JWT 可伪造 + 所有渠道 Key 可解密。
 *
 * 现在拒绝已知占位/弱密钥（黑名单 + 最低熵要求）。生产环境额外严格。
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

/** gateway（对外代理）环境变量 */
export const gatewayEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8787),
  /** JWT 签发密钥（网关自签，HS256 起步） */
  JWT_SECRET: secretSchema('JWT_SECRET', 16),
  /** 渠道上游 Key 的 AES-256-GCM 加密密钥 */
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /** 预扣参数 */
  HOLD_MAX: z.coerce.number().int().min(1).default(50_000), // 厘，默认 ¥50
  HOLD_TTL_SECONDS: z.coerce.number().int().min(1).default(600),
  /** 新用户默认限流（用户级） */
  DEFAULT_USER_RPM: z.coerce.number().int().min(1).default(60),
  DEFAULT_USER_TPM: z.coerce.number().int().min(1).default(1_000_000),
  /**
   * 允许 http:// 与内网上游（仅压测/本地调试）。
   * 双重门控：本开关为 true 且 NODE_ENV !== 'production' 才生效（见 createGatewayAi）。
   * 生产镜像即便误配本开关也安全（被 NODE_ENV 门控拦下）。
   */
  ALLOW_LOCAL_UPSTREAM: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** OTel（可选） */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** worker（计量结算）环境变量 */
export const workerEnvSchema = baseEnvSchema.extend({
  /** 计量队列并发数 */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** admin-api（管理端 REST）环境变量 */
export const adminApiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8790),
  ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
  /**
   * 控制台会话 JWT 密钥（与 gateway 共用同一密钥源）。
   * 必填：控制台登录（/api/auth/login）签发会话 JWT 必须有密钥；缺省则登录功能不可用。
   */
  JWT_SECRET: secretSchema('JWT_SECRET', 16),
  /** 新用户赠送额度（厘），默认 ¥1 = 1000 厘（requirements 4.1） */
  GIFT_AMOUNT: z.coerce.number().int().min(0).default(1_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type AdminApiEnv = z.infer<typeof adminApiEnvSchema>;

/** 解析并校验环境变量，失败即抛错（fail fast） */
export function loadGatewayEnv(env = process.env): GatewayEnv {
  return gatewayEnvSchema.parse(env);
}

export function loadWorkerEnv(env = process.env): WorkerEnv {
  return workerEnvSchema.parse(env);
}

export function loadAdminApiEnv(env = process.env): AdminApiEnv {
  return adminApiEnvSchema.parse(env);
}
