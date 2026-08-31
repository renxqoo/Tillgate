/**
 * 模型映射域契约。
 * 金额仅精确十进制字符串（unitPrice 收窄 number→string）;token/限流走有界 number。
 */
import * as z from 'zod';
import { nonNegativeMoneyString } from './common';

export const MODEL_SORTS = ['id', 'externalName', 'realModel', 'status', 'createdAt'] as const;

const CONTEXT_LENGTH_MAX = 2_000_000_000;

const price = nonNegativeMoneyString;

/**
 * 渠道成本覆盖价（双轨定价）：numeric 字符串可空——''/缺省/null 归一 null（继承映射官方价）。
 * 空串必须 preprocess 先归一：transform 排在基础校验之后，空串直入 nonNegativeMoneyString
 * 会被形状校验拒（绑定行「留空 = 继承」整单 400 的回归锚点）。
 */
const costPrice = z
  .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), price.nullish())
  .transform((v) => (v == null ? null : v.trim()));

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

/** 分时段窗口（schedule 策略）：HH:MM 边界左闭右开，end < start = 跨午夜；价格字段写哪个覆盖哪个 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (00:00-23:59)');

const pricingWindowSchema = z.object({
  label: z.string().min(1).max(32).optional(),
  start: hhmm,
  end: hhmm,
  inputPrice: price.optional(),
  outputPrice: price.optional(),
  cacheInputPrice: price.optional(),
  cacheWritePrice: price.optional(),
  unitPrice: price.optional(),
});

/** 计费配置：variant=分辨率差价 / schedule=分时段窗口（重叠与形状深校验在 control-plane 域） */
const billingConfigSchema = z
  .object({
    strategy: z.enum(['flat', 'variant', 'schedule']),
    params: z
      .object({
        unitPrice: price.optional(),
        selector: z.string().min(1).max(64).optional(),
        prices: z.record(z.string().min(1).max(128), price).optional(),
        windows: z.array(pricingWindowSchema).min(1).max(24).optional(),
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
  )
  .refine(
    (c) => c.strategy !== 'schedule' || (c.params?.windows != null && c.params.windows.length > 0),
    'schedule strategy requires a non-empty windows table',
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

/** 绑定全量替换（空数组 = 解绑全部）;上限防超长数组单事务压行锁。
 *  upstreamModel 留空/空串 = 用映射规范名（application 物化，落库恒显式） */
const modelBindSchema = z.object({
  channels: z
    .array(
      z.object({
        channelId: z.number().int().positive(),
        upstreamModel: z
          .string()
          .trim()
          .max(128)
          .optional()
          .transform((v) => (v === '' ? undefined : v)),
        // 渠道成本覆盖（双轨定价）：可空字符串价格；'' 归一 null（回继承映射官方价）
        costInputPrice: costPrice,
        costOutputPrice: costPrice,
        costCacheInputPrice: costPrice,
        costCacheWritePrice: costPrice,
        costUnitPrice: costPrice,
        /** 成本侧计费配置（与映射 billingConfig 同构：schedule 峰谷成本 / variant 差价成本） */
        costConfig: billingConfigSchema.optional(),
        /** 成本免费显式标记（价格列保持继承默认；true = 成本恒 0） */
        costIsFree: z.boolean().optional(),
      }),
    )
    .max(500),
});

export const modelsContracts = {
  create: modelCreateSchema,
  update: modelUpdateSchema,
  bind: modelBindSchema,
} as const;
