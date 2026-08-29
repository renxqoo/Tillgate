import * as z from 'zod';

/**
 * 路由策略单一真相（组件化的配置面——全部路由可变值集中本文件，别处零散配置即违规）：
 *   - 运行时事实源：RoutingPolicyReader（装配注入；gateway 形态 = routing_policies 表
 *     TTL 热加载，管理台改动 ≤15s 生效，不重启）；
 *   - 编译期缺省：DEFAULT_ROUTING_POLICY（zod 内建 default——reader 无配置/坏值回落）；
 *   - 安全边界：保护机制（熔断/死凭据/预算硬闸）不在此可配——只允许调惩罚/评分参数。
 *
 * 策略对象分五段：scorers（排序信号）/ retry（同渠道预算）/ penalty（惩罚箱）/
 * modelDead（候选死记忆）/ wait（终局有界等待）。管理台按段编辑整版保存（版本化）。
 */

/** cache 亲和评分器：同 (凭证, prompt 前缀) 粘住上次成功渠道（KV cache 经济性） */
const cacheAffinitySchema = z.object({
  enabled: z.boolean().default(false),
  /** sticky 渠道的权重放大倍数（上限 5——过高会垄断流量分布，压过健康信号） */
  boost: z.number().min(1).max(5).default(3),
  /** sticky 键 TTL（对齐上游 cache 档：Anthropic 5m 档缺省） */
  ttlMs: z.number().int().min(10_000).max(3_600_000).default(300_000),
  /** 参与指纹的 messages 前缀字符数（多轮 append-only 对话前缀稳定） */
  prefixChars: z.number().int().min(256).max(65_536).default(4_096),
});

/** 预算软水位评分器：remaining/below 比例低于 softRatio 起线性降权（floor 0.1） */
const budgetWatermarkSchema = z.object({
  enabled: z.boolean().default(true),
  softRatio: z.number().min(0.01).max(1).default(0.2),
});

const CACHE_AFFINITY_DEFAULT = { enabled: false, boost: 3, ttlMs: 300_000, prefixChars: 4_096 };
const BUDGET_WATERMARK_DEFAULT = { enabled: true, softRatio: 0.2 };

const scorersSchema = z.object({
  cacheAffinity: cacheAffinitySchema.default(CACHE_AFFINITY_DEFAULT),
  budgetWatermark: budgetWatermarkSchema.default(BUDGET_WATERMARK_DEFAULT),
});

/** 同渠道重试预算（瞬态类扛短暂限流——退避下界已实现取 Retry-After） */
const retrySchema = z.object({
  sameChannelMaxRetries: z.number().int().min(1).max(6).default(3),
});

/** 渠道惩罚箱（429/quota 冷却）。conditionalBypass=true 时全渠道冷却放行（防假性 503；单渠道场景天然落此分支） */
const penaltySchema = z.object({
  rateLimitBaseMs: z.number().int().min(100).max(60_000).default(2_000),
  rateLimitMaxMs: z.number().int().min(1_000).max(600_000).default(60_000),
  quotaMs: z.number().int().min(10_000).max(86_400_000).default(1_800_000),
  conditionalBypass: z.boolean().default(true),
});

/** 候选死记忆（全渠道连续耗尽 → TTL 窗口内跳过该候选） */
const modelDeadSchema = z.object({
  failureThreshold: z.number().int().min(2).max(10).default(3),
  ttlMs: z.number().int().min(5_000).max(600_000).default(60_000),
  windowMs: z.number().int().min(10_000).max(3_600_000).default(300_000),
});

/** 终局有界等待：全渠道竭尽且最早恢复 <maxWaitMs 时网关内等待后重试一轮（消化瞬态限流） */
const waitSchema = z.object({
  enabled: z.boolean().default(true),
  maxWaitMs: z.number().int().min(100).max(5_000).default(2_000),
});

/** 交叉校验：429 冷却基线不得超封顶（超限时 base 被钳到 max——「看似生效实际被钳」必须拒绝） */
const penaltyBoundsRefine = (
  data: { penalty: { rateLimitBaseMs: number; rateLimitMaxMs: number } },
  ctx: z.RefinementCtx,
): void => {
  if (data.penalty.rateLimitBaseMs > data.penalty.rateLimitMaxMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['penalty', 'rateLimitBaseMs'],
      message: 'rateLimitBaseMs must not exceed rateLimitMaxMs',
    });
  }
};

export const routingPolicySchema = z
  .object({
    /** 策略版本（每次保存自增——观测/回滚锚点） */
    version: z.number().int().min(1).default(1),
    scorers: scorersSchema.default({
      cacheAffinity: CACHE_AFFINITY_DEFAULT,
      budgetWatermark: BUDGET_WATERMARK_DEFAULT,
    }),
    retry: retrySchema.default({ sameChannelMaxRetries: 3 }),
    penalty: penaltySchema.default({
      rateLimitBaseMs: 2_000,
      rateLimitMaxMs: 60_000,
      quotaMs: 1_800_000,
      conditionalBypass: true,
    }),
    modelDead: modelDeadSchema.default({ failureThreshold: 3, ttlMs: 60_000, windowMs: 300_000 }),
    wait: waitSchema.default({ enabled: true, maxWaitMs: 2_000 }),
  })
  .superRefine(penaltyBoundsRefine);

export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

/** 编译期缺省（reader 无配置/坏值回落——路由永不因配置缺失而挂） */
export function defaultRoutingPolicy(): RoutingPolicy {
  return routingPolicySchema.parse({});
}
