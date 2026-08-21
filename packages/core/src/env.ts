import { z } from 'zod';

const KNOWN_WEAK_SECRETS = new Set([
  'change-me',
  'secret',
  'password',
  'changeme',
  'test-jwt-secret-min-16-chars',
  'test-encryption-key-32-chars-min!!',
  'change-me-32-chars-minimum-secret',
  'passwordpassword',
]);

/** 环境变量布尔值只接受精确 true/false，也允许装配测试直接传 boolean。 */
export function strictBooleanSchema(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .default(defaultValue);
}

/** 密钥必须满足长度、已知弱值和最低字符多样性三道门。 */
export function secretSchema(field: string, minLen: number) {
  return z
    .string()
    .min(minLen, `${field} 至少 ${minLen} 字符`)
    .refine((value) => !KNOWN_WEAK_SECRETS.has(value), {
      message: `${field} must not use a placeholder or weak secret (e.g. change-me-*, secret, password)`,
    })
    .refine((value) => new Set(value).size >= 4, {
      message: `${field} has too few distinct characters (at least 4 required)`,
    });
}

const traceReceiverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/ai_gateway'),
  TRACE_RECEIVER_PORT: z.coerce.number().int().min(1).default(8793),
  TRACE_RECEIVER_TOKEN: z.string().min(16).optional(),
  TRACE_BATCH_MAX: z.coerce.number().int().min(1).default(500),
  TRACE_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
  TRACE_QUEUE_MAX: z.coerce.number().int().min(100).default(10_000),
  OTEL_TRACES_MODE: z.enum(['off', 'memory', 'console', 'otlp']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type TraceReceiverEnv = ReturnType<typeof loadTraceReceiverEnv>;

/** trace-receiver 仍是独立进程，因此保留其唯一实际使用的共享配置入口。 */
export function loadTraceReceiverEnv(env: NodeJS.ProcessEnv = process.env) {
  const parsed = traceReceiverEnvSchema.parse(env);
  const mode = parsed.OTEL_TRACES_MODE ?? (parsed.NODE_ENV === 'production' ? 'off' : 'memory');
  if (mode === 'otlp' && !parsed.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error('OTEL_TRACES_MODE=otlp 时必须配置 OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  if (parsed.NODE_ENV === 'production' && !parsed.TRACE_RECEIVER_TOKEN) {
    throw new Error('production 环境必须设置 TRACE_RECEIVER_TOKEN（链路接收端鉴权）');
  }
  return { ...parsed, OTEL_TRACES_MODE: mode };
}
