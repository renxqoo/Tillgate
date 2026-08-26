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
