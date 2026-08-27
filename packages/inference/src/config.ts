import * as z from 'zod';

/**
 * inference 配置（机制/预算缺省值；装配可整体或分组覆写）。
 * 注：zod 4 的 .default() 默认值需为完整输出形状，故显式写出（与 ai 包同形态）。
 * 金额、费率、目录等策略数据一律不经配置——目录快照来自 CatalogPort，资金归 BillingPort。
 */
export const inferenceDefaultsSchema = z.object({
  /** 渠道熔断（计数依据 = ai 错误 circuitTrip 机制位） */
  breaker: z
    .object({
      windowMs: z.number().int().min(1).default(60_000),
      failureThreshold: z.number().int().min(1).default(5),
      cooldownMs: z.number().int().min(1).default(300_000),
      halfOpenProbe: z.boolean().default(true),
    })
    .default({ windowMs: 60_000, failureThreshold: 5, cooldownMs: 300_000, halfOpenProbe: true }),
  /** 死凭据连续计数（单阈值；成功自愈） */
  deadCredential: z
    .object({
      failureThreshold: z.number().int().min(1).default(3),
      windowMs: z.number().int().min(1).default(3_600_000),
    })
    .default({ failureThreshold: 3, windowMs: 3_600_000 }),
  /** 输出上界（预扣敞口与转发硬上限共用口径） */
  output: z
    .object({
      defaultMaxOutputTokens: z.number().int().min(1).default(4_096),
      exposureCap: z.number().int().min(1).default(32_768),
    })
    .default({ defaultMaxOutputTokens: 4_096, exposureCap: 32_768 }),
  /** 授权租约 TTL（流式续租基准） */
  authorization: z
    .object({
      ttlMs: z.number().int().min(1).default(300_000),
    })
    .default({ ttlMs: 300_000 }),
  /** 流式租约续期节奏（1/3 TTL，下限 1s；上限次防终态永不到达的泄漏） */
  streamLease: z
    .object({
      minRenewIntervalMs: z.number().int().min(1).default(1_000),
      maxRenewals: z.number().int().min(1).default(100),
    })
    .default({ minRenewIntervalMs: 1_000, maxRenewals: 100 }),
  /** 终态 signal 退避重试（结算落账收尾） */
  settleSignal: z
    .object({
      attempts: z.number().int().min(1).default(5),
      baseDelayMs: z.number().int().min(0).default(500),
      maxDelayMs: z.number().int().min(1).default(8_000),
    })
    .default({ attempts: 5, baseDelayMs: 500, maxDelayMs: 8_000 }),
  /** 生成任务生命周期 */
  generation: z
    .object({
      taskTtlMs: z.number().int().min(1).default(3_600_000),
      leaseGraceMs: z.number().int().min(0).default(30_000),
    })
    .default({ taskTtlMs: 3_600_000, leaseGraceMs: 30_000 }),
  /** 缺 usage 的实扣估算校准系数（装配可调） */
  estimate: z
    .object({
      cjkTokensPerChar: z.number().min(0).default(0.7),
      tokensPerWord: z.number().min(0).default(1.1),
      tokensPerNumber: z.number().min(0).default(1.0),
      tokensPerSymbol: z.number().min(0).default(1.0),
    })
    .default({
      cjkTokensPerChar: 0.7,
      tokensPerWord: 1.1,
      tokensPerNumber: 1.0,
      tokensPerSymbol: 1.0,
    }),
  /** 单次上游尝试预算（透传给 ai CallOptions.deadlineMs） */
  upstream: z
    .object({
      deadlineMs: z.number().int().min(1).default(120_000),
    })
    .default({ deadlineMs: 120_000 }),
});

export type InferenceDefaults = z.infer<typeof inferenceDefaultsSchema>;
export type InferenceDefaultsInput = z.input<typeof inferenceDefaultsSchema>;

export function defaultInferenceDefaults(): InferenceDefaults {
  return inferenceDefaultsSchema.parse({});
}
