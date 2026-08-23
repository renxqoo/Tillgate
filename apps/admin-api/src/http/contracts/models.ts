/**
 * 模型映射域契约（v1 routes/models.ts zod 面平移）。
 * 金额仅精确十进制字符串（unitPrice 收窄 number→string）;token/限流走有界 number。
 */
import { z } from 'zod';
import { nonNegativeMoneyString } from './common';

export const MODEL_SORTS = ['id', 'externalName', 'realModel', 'status', 'createdAt'] as const;

const CONTEXT_LENGTH_MAX = 2_000_000_000;

const price = nonNegativeMoneyString;

/** 多模态统一输入计费策略（billingPolicy 消费方在网关 build-quote/receipt） */
const billingPolicySchema = z.object({
  version: z.literal(1),
  billingMode: z.literal('unified_input_tokens'),
  maxInputTokens: z.number().int().positive(),
  modalities: z
    .object({
      image: z
        .object({
          maxItems: z.number().int().positive(),
          maxInlineBytes: z.number().int().positive().optional(),
        })
        .optional(),
      audio: z
        .object({
          maxItems: z.number().int().positive(),
          maxInlineBytes: z.number().int().positive().optional(),
        })
        .optional(),
      file: z
        .object({
          maxItems: z.number().int().positive(),
          maxInlineBytes: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .strict(),
});

/** 变体价格配置（分辨率差价）：selector=请求参数名（如 size），prices=参数值→单价 */
const billingConfigSchema = z
  .object({
    strategy: z.enum(['flat', 'variant']),
    params: z
      .object({
        unitPrice: price.optional(),
        selector: z.string().min(1).max(64).optional(),
        prices: z.record(z.string().min(1).max(128), price).optional(),
      })
      .optional(),
  })
  .refine(
    (c) =>
      c.strategy !== 'variant' ||
      (c.params?.prices != null && Object.keys(c.params.prices).length > 0),
    'variant strategy requires a prices table',
  )
  .refine(
    (c) => c.strategy !== 'variant' || c.params?.selector != null,
    'variant strategy requires a selector (request parameter name, e.g. size)',
  );

const pricingUnit = z.enum(['token', 'request', 'image', 'second', 'char']);

const modelCreateSchema = z.object({
  externalName: z.string().min(1).max(64),
  realModel: z.string().min(1).max(128),
  contextLength: z.coerce
    .number()
    .int()
    .positive()
    .finite()
    .max(CONTEXT_LENGTH_MAX)
    .nullable()
    .optional(),
  inputPrice: price,
  outputPrice: price,
  cacheInputPrice: price,
  /** 缓存写单价（元/百万 token;缺省 0 = 不收缓存写费） */
  cacheWritePrice: price.optional(),
  /** 计价单位（token 缺省;image/second/char/request 单位计价） */
  pricingUnit: pricingUnit.default('token'),
  /** 单位单价（元/单位;单位计价模型必填,token 模型留空=0——number 收窄为字符串） */
  unitPrice: z
    .union([
      price,
      z.coerce
        .number()
        .min(0)
        .finite()
        .max(1e12)
        .transform((v) => String(v)),
    ])
    .optional(),
  /** 变体价格（分辨率差价）;null = 清除 */
  billingConfig: billingConfigSchema.nullable().optional(),
  isFree: z.boolean().optional(),
  billingPolicy: billingPolicySchema.nullable().optional(),
  rpmLimit: z.coerce.number().int().positive().max(1e9).nullable().optional(),
  tpmLimit: z.coerce.number().int().positive().max(1e9).nullable().optional(),
});

const modelUpdateSchema = z.object({
  externalName: z.string().min(1).max(64).optional(),
  realModel: z.string().min(1).max(128).optional(),
  contextLength: z.coerce
    .number()
    .int()
    .positive()
    .finite()
    .max(CONTEXT_LENGTH_MAX)
    .nullable()
    .optional(),
  status: z.number().int().min(0).max(1).optional(),
  inputPrice: price.optional(),
  outputPrice: price.optional(),
  cacheInputPrice: price.optional(),
  cacheWritePrice: price.optional(),
  pricingUnit: pricingUnit.optional(),
  unitPrice: z
    .union([
      price,
      z.coerce
        .number()
        .min(0)
        .finite()
        .max(1e12)
        .transform((v) => String(v)),
    ])
    .optional(),
  billingConfig: billingConfigSchema.nullable().optional(),
  isFree: z.boolean().optional(),
  billingPolicy: billingPolicySchema.nullable().optional(),
  rpmLimit: z.coerce.number().int().positive().nullable().optional(),
  tpmLimit: z.coerce.number().int().positive().nullable().optional(),
});

/** 绑定全量替换（空数组 = 解绑全部）;上限防超长数组单事务压行锁 */
const modelBindSchema = z.object({
  channels: z
    .array(
      z.object({
        channelId: z.number().int().positive(),
        weight: z.number().optional(),
        priority: z.number().optional(),
      }),
    )
    .max(500),
});

export const modelsContracts = {
  create: modelCreateSchema,
  update: modelUpdateSchema,
  bind: modelBindSchema,
} as const;
