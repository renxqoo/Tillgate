import {
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { modelMappings } from './model-mappings.js';

/**
 * rate_cards — 费率卡（定价档位，data-model.md §3.8）
 * 定价模型：用户价 = 官方价（model_mappings）× 费率卡系数；账户绑定一张卡
 */
export const rateCards = pgTable(
  'rate_cards',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 32 }).notNull(),
    description: varchar('description', { length: 255 }),
    /** 0 启用 / 1 停用（停用后新请求拒绝，已签发 JWT 按快照继续） */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('rate_cards_name_uq').on(t.name)],
);

/**
 * rate_card_coefficients — 费率卡系数（data-model.md §3.9）
 * 解析优先级：model（按 model_mapping_id）> group（按 model_mappings.pricing_group 匹配 group_key）
 * > global（兜底）；解析器单一真相 = packages/ledger/src/billing/coefficient.ts。
 * 约束：每卡必有且仅有一行 global；model 行 model_mapping_id 非空；group 行 group_key 非空。
 */
export const rateCardCoefficients = pgTable(
  'rate_card_coefficients',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rateCardId: bigint('rate_card_id', { mode: 'number' })
      .notNull()
      .references(() => rateCards.id),
    /** global 全局 / model 按模型 / group 按定价分组 */
    scope: varchar('scope', { length: 8 }).notNull(),
    modelMappingId: bigint('model_mapping_id', { mode: 'number' }).references(
      () => modelMappings.id,
    ),
    /** scope='group' 行的分组键（与 model_mappings.pricing_group 匹配）；其余 scope 为 NULL */
    groupKey: varchar('group_key', { length: 32 }),
    /** 系数（1.0 = 按官方价原价） */
    coefficient: numeric('coefficient', { precision: 6, scale: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rate_card_coefficients_uq').on(t.rateCardId, t.scope, t.modelMappingId),
    // 全局行（model_mapping_id IS NULL）每卡每 scope 至多一条——
    // 原 uq 因 NULLS DISTINCT 拦不住重复全局行。
    uniqueIndex('rate_card_coefficients_global_uq')
      .on(t.rateCardId, t.scope)
      .where(sql`model_mapping_id is null`),
    // group 行每卡每分组键至多一条；model 行按 uq(rate_card_id, scope, model_mapping_id) 去重
    uniqueIndex('rate_card_coefficients_group_uq')
      .on(t.rateCardId, t.groupKey)
      .where(sql`scope = 'group' and group_key is not null`),
    index('rate_card_coefficients_mapping_idx').on(t.modelMappingId),
    // scope 词表（新增 scope 须同步 coefficient.ts 解析器）
    check('rate_card_coefficients_scope_ck', sql`${t.scope} in ('global','model','group')`),
  ],
);
