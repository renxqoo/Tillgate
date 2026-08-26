/**
 * 控制面域契约（v1 providers/channels/channel-funds zod 面平移）。
 * 数值域铁三角在 zod 层收口：URL 形状/长度上界;协议词表校验在 control-plane。
 */
import * as z from 'zod';
import { nonNegativeMoneyString, positiveMoneyString, signedNonZeroMoneyString } from './common';

export const PROVIDER_SORTS = ['id', 'name', 'status', 'createdAt'] as const;
export const CHANNEL_SORTS = ['id', 'name', 'status', 'priority', 'createdAt'] as const;
export const CHANNEL_FUNDS_SORTS = ['id', 'amount', 'createdAt'] as const;

const providerCreateSchema = z.object({
  name: z.string().min(1).max(32),
  protocol: z.string().max(32).optional(),
  /** 厂商档案引用（词表校验在 control-plane;null/空串 = 清除——纯透传） */
  vendor: z.string().max(32).nullable().optional(),
  baseUrl: z.string().url().max(255),
  status: z.number().int().min(0).max(1).optional(),
});

const providerUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  protocol: z.string().max(32).optional(),
  vendor: z.string().max(32).nullable().optional(),
  baseUrl: z.string().url().max(255).optional(),
  status: z.number().int().min(0).max(1).optional(),
});

/** 模型白名单线上契约 = string[]（逗号串 4xx——转换职责在调用方边界） */
const channelCreateSchema = z.object({
  providerId: z.number().int().positive(),
  name: z.string().min(1, 'name must not be empty').max(64),
  apiKey: z.string().min(1, 'apiKey must not be empty').max(512),
  baseUrlOverride: z.string().max(255).nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
  weight: z.number().int().min(0).max(1_000_000).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
});

const channelUpdateSchema = channelCreateSchema.partial().extend({
  providerId: z.number().int().positive().optional(),
  status: z.number().int().min(0).max(4).optional(),
  /** 熔断阈值（null = 清阈值——透传落库;资金值禁 IEEE-754） */
  upstreamThreshold: nonNegativeMoneyString.nullable().optional(),
});

const channelImportItemSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(512),
  models: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  priority: z.number().int().optional(),
});

const channelImportSchema = z.object({
  channels: z.array(channelImportItemSchema).min(1).max(1000),
});

const channelFundsListQueryExtra = z.object({
  channelId: z.coerce.number().int().positive().optional(),
  type: z.enum(['recharge', 'adjust']).optional(),
});

const rechargeSchema = z.object({
  channelId: z.number().int().positive(),
  amount: positiveMoneyString,
  orderNo: z.string().max(128).optional(),
  /** 进货凭证（data URL 内联;上限由装配 voucherMaxBytes 守卫） */
  voucherDataUrl: z.string().max(20_000_000).optional(),
  remark: z.string().max(255).optional(),
});

const channelAdjustSchema = z.object({
  channelId: z.number().int().positive(),
  amount: signedNonZeroMoneyString,
  remark: z.string().max(255).optional(),
});

export const providersContracts = {
  create: providerCreateSchema,
  update: providerUpdateSchema,
} as const;

export const channelsContracts = {
  create: channelCreateSchema,
  update: channelUpdateSchema,
  import: channelImportSchema,
} as const;

export const channelFundsContracts = {
  listQueryExtra: channelFundsListQueryExtra,
  recharge: rechargeSchema,
  adjust: channelAdjustSchema,
} as const;
