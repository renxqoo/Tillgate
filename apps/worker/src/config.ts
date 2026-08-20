/**
 * 环境配置（zod，装配唯一入口）：驱动节奏全部显式——
 * 轮询是正确性兜底（真相在 DB 认领），BullMQ 唤醒只是低延迟优化（待接 Redis 时加）。
 */
import { z } from 'zod';
import { secretSchema, strictBooleanSchema } from '@ai-gateway/core';

const nonNegativeDecimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);

const schema = z.object({
  /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WORKER_CURRENCY: z.string().default('CNY'),
  /** 副本标识（认领 owner——多副本安全由 SKIP LOCKED 保证） */
  WORKER_OWNER_ID: z.string().default(`worker-${process.pid}`),
  /** 结算批次与租约 */
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  WORKER_CLAIM_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  /** 失败处置策略（指数退避）：分钟级退避 + 10 次预算 ≈ 85 分钟耐受——
   *  秒级预算下一次 PG 抖动就会把整批 pending 打成死信冻结用户资金 */
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  WORKER_BASE_DELAY_MS: z.coerce.number().int().positive().default(15_000),
  WORKER_MAX_DELAY_MS: z.coerce.number().int().positive().default(600_000),
  /** 结算唤醒消费端开关（默认开；测试可关以防偷消费共享队列） */
  WORKER_SETTLE_WAKEUP: strictBooleanSchema(true),
  /** 驱动节奏：结算扫描为 BullMQ 唤醒的兜底（默认 30s；唤醒通道故障时退化为该节奏） */
  WORKER_SETTLE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_RECOVER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  WORKER_RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  /** 生成任务轮询：节奏 / 批量 / 续租下限（须 ≥ 2× 间隔）/ 超时原因词汇 */
  WORKER_GENERATION_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  WORKER_GENERATION_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  WORKER_GENERATION_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_GENERATION_EXPIRE_REASON: z.string().default('任务超时（TTL 到期）'),
  /** 邀请返利：佣金比例（0–1；0 = 关闭）与日结节奏 */
  REFERRAL_COMMISSION_RATE: z.string().regex(/^(?:0(?:\.\d{1,18})?|1(?:\.0{1,18})?)$/).default('0'),
  WORKER_REFERRAL_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** 告警投递（notify_outbox 消费者——webhook/邮件；v1 对位循环） */
  WORKER_NOTIFY_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  /** 单行通知认领租约；须覆盖 webhook 10s 超时和 SMTP 投递上界。 */
  WORKER_NOTIFY_CLAIM_LEASE_MS: z.coerce.number().int().min(15_000).default(60_000),
  /** 告警投递总闸（默认开）：dev 共享库跑测试会源源产生 channel_disabled/billing_dead
   *  告警事件——配了真实邮箱/webhook 渠道的开发机设 false 静音（事件仍入箱可查，只是不投递）。 */
  WORKER_NOTIFY_ENABLED: strictBooleanSchema(true),
  /** 周期对账哨兵（wallet 复式不变量核验——资损最后防线） */
  WORKER_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** 分区维护节奏与保留期（trace_spans / request_logs——缺位则窗口过后插入失败） */
  WORKER_PARTITION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  TRACE_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  REQUEST_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** 余额预警阈值（元；结算后低于即 balance_low 入箱，按用户×日幂等） */
  WORKER_BALANCE_LOW_THRESHOLD: nonNegativeDecimal.default('5'),
  /** 健康端点（compose healthcheck 依赖；0 = 关闭——测试隔离用；
   *  /health 深度报告令牌——空 = 恒 403） */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).default(8792),
  WORKER_HEALTH_TOKEN: z.string().default(''),
  /** 通知邮件 SMTP（可选；未配置 = email 渠道 fail-closed 跳过） */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** 渠道 apiKeyEnc 解密密钥（任务适配器用） */
  CHANNEL_API_KEY_ENCRYPTION: secretSchema('CHANNEL_API_KEY_ENCRYPTION', 32),
  /** 允许上游寻址回环/私网（SSRF 防护 dev/test 逃生门——生产恒为 false） */
  WORKER_AI_ALLOW_LOCAL_URL: strictBooleanSchema(false),
  /** 允许 webhook 投递寻址回环/私网（同上——生产恒为 false；webhook 仍要求 https） */
  WORKER_WEBHOOK_ALLOW_LOCAL_URL: strictBooleanSchema(false),
  /** 优雅停机：等待在途批次完成的上界（ms） */
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(15_000),
  /** 链路追踪（与网关同源：otlp = 导出 trace-receiver；结算 span 挂 request.id 关联请求链） */
  OTEL_TRACES_MODE: z.enum(['off', 'memory', 'console', 'otlp']).default('off'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = schema.parse({
    ...env,
    // 渠道密钥：专用名优先，缺省回落 .env 规范键 ENCRYPTION_KEY（两处都未配置 =
    // 启动即失败——fail-closed，不带默认值）
    CHANNEL_API_KEY_ENCRYPTION: env.CHANNEL_API_KEY_ENCRYPTION ?? env.ENCRYPTION_KEY,
  });
  // otlp 成组校验（与网关同语义：半配 = 启动失败，fail-closed）
  if (config.OTEL_TRACES_MODE === 'otlp' && !config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error('OTEL_TRACES_MODE=otlp 时必须配置 OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  return config;
}
