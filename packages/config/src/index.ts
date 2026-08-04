import { z } from 'zod'

/** 共享环境变量 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z
    .string()
    .default('postgres://postgres:postgres@localhost:5432/ai_gateway'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
})

/** gateway（对外代理）环境变量 */
export const gatewayEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8787),
  /** JWT 签发密钥（网关自签，HS256 起步） */
  JWT_SECRET: z.string().min(16),
  /** 渠道上游 Key 的 AES-256-GCM 加密密钥 */
  ENCRYPTION_KEY: z.string().min(32),
  /** 预扣参数 */
  HOLD_MAX: z.coerce.number().int().min(1).default(50_000), // 厘，默认 ¥50
  HOLD_TTL_SECONDS: z.coerce.number().int().min(1).default(600),
  /** 新用户默认限流（用户级） */
  DEFAULT_USER_RPM: z.coerce.number().int().min(1).default(60),
  DEFAULT_USER_TPM: z.coerce.number().int().min(1).default(1_000_000),
  /** OTel（可选） */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

/** worker（计量结算）环境变量 */
export const workerEnvSchema = baseEnvSchema.extend({
  /** 计量队列并发数 */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

/** admin-api（管理端 REST）环境变量 */
export const adminApiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).default(8790),
  ENCRYPTION_KEY: z.string().min(32),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>
export type WorkerEnv = z.infer<typeof workerEnvSchema>
export type AdminApiEnv = z.infer<typeof adminApiEnvSchema>

/** 解析并校验环境变量，失败即抛错（fail fast） */
export function loadGatewayEnv(env = process.env): GatewayEnv {
  return gatewayEnvSchema.parse(env)
}

export function loadWorkerEnv(env = process.env): WorkerEnv {
  return workerEnvSchema.parse(env)
}

export function loadAdminApiEnv(env = process.env): AdminApiEnv {
  return adminApiEnvSchema.parse(env)
}
