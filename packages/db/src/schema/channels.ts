import {
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  jsonb,
  text,
  numeric,
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
    /**
     * 当前余额（元）= 渠道「有没有钱」的唯一依据。入货 +、调账 ±、结算时按实际上游成本原子扣减。
     * 余额 ≤ 0 即「没钱」，路由精确硬闸拦截新请求；余额可为负（历史/在途超支）。
     */
    upstreamBudget: numeric('upstream_budget', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /**
     * 熔断阈值（元）。剩余 ≤ 此值 → 自动熔断（status=3）+ 清路由缓存。
     * NULL = 0（耗尽才熔断）。仅 upstream_budget > 0 时生效。
     */
    upstreamThreshold: numeric('upstream_threshold', { precision: 38, scale: 18 }),
    /**
     * 在途上游成本敞口（元）。路由选渠时原子累加本次上游预估，结算/释放时原子扣减。
     * 仅 upstream_budget > 0 的渠道启用（精确硬闸）；与 billing_requests.channel_reserved_amount 对应。
     */
    upstreamReserved: numeric('upstream_reserved', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channels_provider_id_idx').on(t.providerId)],
);
