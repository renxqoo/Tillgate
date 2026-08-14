import {
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  numeric,
} from 'drizzle-orm/pg-core';
import { channels } from './channels.js';

/**
 * model_mappings — 模型映射（对外模型名 → 真实模型，data-model.md §3.6）
 * 定价：input/output/cache_input 均为**官方价**（元/百万 token），用户价 = 官方价 × 费率卡系数
 */
export const modelMappings = pgTable(
  'model_mappings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    externalName: varchar('external_name', { length: 64 }).notNull(),
  /** 上下文窗口（token 数）；null=未知。目录导入带入，可编辑。 */
  contextLength: bigint('context_length', { mode: 'number' }),
    realModel: varchar('real_model', { length: 128 }).notNull(),
    /** 0 上架 / 1 下架 */
    status: smallint('status').notNull().default(0),
    /** 官方输入单价（元/百万 token，numeric 全精度） */
    inputPrice: numeric('input_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 官方输出单价 */
    outputPrice: numeric('output_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 官方缓存输入单价（缓存命中计价；不启用缓存计费则与输入价同值） */
    cacheInputPrice: numeric('cache_input_price', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /** fallback 模型链（对外模型名数组，配置启用；默认空 = 不降级） */
    fallbackModels: jsonb('fallback_models').$type<string[]>(),
    /**
     * 参数抹平规则（透传基底，规则驱动，见 ai-package.md §7.6）：
     * {"ignore":[],"clamp":{},"map":{},"unknown":"passthrough"}
     */
    paramRules: jsonb('param_rules').$type<{
      ignore?: string[];
      clamp?: Record<string, { min?: number; max?: number }>;
      map?: Record<string, { to: string }>;
      unknown?: 'passthrough' | 'drop';
    }>(),
    /** 版本化多模态足额授权策略；最终结算仍只使用供应商可信 usage。 */
    billingPolicy: jsonb('billing_policy').$type<Record<string, unknown>>(),
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('model_mappings_external_name_uq').on(t.externalName)],
);

/**
 * model_channels — 映射 × 渠道 关联（data-model.md §3.7）
 * 上架约束：上架模型必须 ≥1 个可用渠道（应用层校验）
 */
export const modelChannels = pgTable(
  'model_channels',
  {
    mappingId: bigint('mapping_id', { mode: 'number' })
      .notNull()
      .references(() => modelMappings.id),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => channels.id),
    weight: bigint('weight', { mode: 'number' }).notNull().default(1),
    priority: bigint('priority', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    { name: 'model_channels_pk', columns: [t.mappingId, t.channelId], primaryKey: true },
    index('model_channels_channel_id_idx').on(t.channelId),
  ],
);
