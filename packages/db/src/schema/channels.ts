import {
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { providers } from './providers.js';

/**
 * channels — 渠道（供应商 × 上游 Key，data-model.md §3.5）
 * status: 0 启用 / 1 禁用 / 2 维护 / 3 熔断(自动) / 4 凭据无效（连续 401/403，换 Key 后恢复）
 */
export const channels = pgTable(
  'channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    providerId: bigint('provider_id', { mode: 'number' })
      .notNull()
      .references(() => providers.id),
    name: varchar('name', { length: 64 }).notNull(),
    /** AES-GCM 加密后的上游 Key（密钥在环境变量） */
    apiKeyEnc: text('api_key_enc').notNull(),
    baseUrlOverride: varchar('base_url_override', { length: 255 }),
    /** 上游模型名白名单；NULL 或空数组 = 不限；非空时路由取「映射渠道列表 ∩ 白名单」 */
    models: jsonb('models').$type<string[]>(),
    weight: bigint('weight', { mode: 'number' }).notNull().default(1),
    priority: bigint('priority', { mode: 'number' }).notNull().default(0),
    status: smallint('status').notNull().default(0),
    /** 连续失败次数（熔断判定，仅计 circuitTrip 错误） */
    failCount: bigint('fail_count', { mode: 'number' }).notNull().default(0),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    /** 渠道级限流（保护上游配额） */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channels_provider_id_idx').on(t.providerId)],
);
