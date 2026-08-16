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
 * 约束：每卡必有且仅有一行 global（兜底系数，应用层保证）；scope 预留 group（二期）
 */
export const rateCardCoefficients = pgTable(
  'rate_card_coefficients',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rateCardId: bigint('rate_card_id', { mode: 'number' })
      .notNull()
      .references(() => rateCards.id),
    /** global 全局 / model 按模型（二期）/ group 按分组（二期预留） */
    scope: varchar('scope', { length: 8 }).notNull(),
    modelMappingId: bigint('model_mapping_id', { mode: 'number' }).references(
      () => modelMappings.id,
    ),
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
    index('rate_card_coefficients_mapping_idx').on(t.modelMappingId),
  ],
);
