/**
 * 环境配置（zod，装配唯一入口）：驱动节奏全部显式——
 * 轮询是正确性兜底（真相在 DB 认领），BullMQ 唤醒只是低延迟优化（待接 Redis 时加）。
 */
import { z } from 'zod';

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
  WORKER_SETTLE_WAKEUP: z.coerce.boolean().default(true),
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
  REFERRAL_COMMISSION_RATE: z.coerce.number().min(0).max(1).default(0),
  WORKER_REFERRAL_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** 渠道 apiKeyEnc 解密密钥（任务适配器用） */
  CHANNEL_API_KEY_ENCRYPTION: z.string().min(1),
  /** 允许上游寻址回环/私网（SSRF 防护 dev/test 逃生门——生产恒为 false） */
  WORKER_AI_ALLOW_LOCAL_URL: z.coerce.boolean().default(false),
  /** 优雅停机：等待在途批次完成的上界（ms） */
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(15_000),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return schema.parse({
    ...env,
    // 渠道密钥：专用名优先，缺省回落 .env 规范键 ENCRYPTION_KEY（两处都未配置 =
    // 启动即失败——fail-closed，不带默认值）
    CHANNEL_API_KEY_ENCRYPTION: env.CHANNEL_API_KEY_ENCRYPTION ?? env.ENCRYPTION_KEY,
  });
}
