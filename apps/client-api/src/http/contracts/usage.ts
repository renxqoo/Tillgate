/**
 * 用量契约：明细（时间窗/模型过滤 + 分页）与聚合（时间窗）。
 */
import * as z from 'zod';
import { listQuerySchema } from './shared.js';

export const usageListQuerySchema = listQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  model: z.string().max(64).optional(),
});

export const usageRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * trend 查询：granularity 缺省 day；hour 粒度窗口由后端按「今日当地 00:00」
 * 单一真相推导——from 只对 day 有意义，hour + from 显式拒绝（静默忽略会造
 * 「传了参数但结果与它无关」的契约歧义）。
 */
export const usageTrendQuerySchema = z
  .object({
    granularity: z.enum(['day', 'hour']).default('day'),
    from: z.string().datetime().optional(),
  })
  .superRefine((query, ctx) => {
    if (query.granularity === 'hour' && query.from != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from is only accepted with granularity=day',
      });
    }
  });

/** 用量明细 wire 行（api-client UsageRow 口径；usage_logs 投影 + 名称富化） */
export interface UsageWireRow {
  id: number;
  requestId: string;
  userId: number;
  appId: number | null;
  apiKeyId: number | null;
  externalModel: string;
  realModel: string;
  channelId: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  units: number;
  unitPrice: string | null;
  pricingUnit: string | null;
  amount: string;
  billedBy: 'plan' | 'payg';
  planAmount: string;
  paygAmount: string;
  upstreamCost: string | null;
  durationMs: number;
  clientTtftMs: number | null;
  createdAt: Date;
  credentialType: string;
  keyName: string | null;
  appName: string | null;
}

/** 按模型聚合行 */
export interface UsageByModelRow {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: string;
}

/** 按日汇总行（日界 = CLIENT_USAGE_TZ） */
export interface UsageDayRow {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: string;
}

/** 趋势聚合行（模型 × 桶；day 桶日界 / hour 桶为 CLIENT_USAGE_TZ 当地时点） */
export interface UsageTrendRow {
  /** day: yyyy-MM-dd；hour: yyyy-MM-ddTHH:mm:ss（CLIENT_USAGE_TZ 当地） */
  bucket: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: string;
}
