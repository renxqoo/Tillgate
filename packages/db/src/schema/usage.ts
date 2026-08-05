import {
  pgTable,
  bigserial,
  uuid,
  varchar,
  smallint,
  timestamp,
  bigint,
  boolean,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { apps } from './apps.js';
import { apiKeys } from './api-keys.js';
import { channels } from './channels.js';
import { userSubscriptions } from './plans.js';

/**
 * usage_logs — 用量明细（只追加、长期保留，data-model.md §3.10）
 * 计费：amount = (未缓存输入×输入价 + 缓存输入×缓存价 + 输出×输出价)/1e6 × 系数
 * status: 0 成功已计费 / 1 失败不计费（一期仅 0/1；透支如实扣全额，余额可为负=欠款，不单列坏账状态）
 */
export const usageLogs = pgTable(
  'usage_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 网关内部请求 ID，天然幂等（同请求只计一次） */
    requestId: uuid('request_id').notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    appId: bigint('app_id', { mode: 'number' }).references(() => apps.id),
    apiKeyId: bigint('api_key_id', { mode: 'number' }).references(() => apiKeys.id),
    /** key / jwt */
    credentialType: varchar('credential_type', { length: 8 }).notNull(),
    externalModel: varchar('external_model', { length: 64 }).notNull(),
    realModel: varchar('real_model', { length: 128 }).notNull(),
    channelId: bigint('channel_id', { mode: 'number' }).references(() => channels.id),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    /** 缓存命中输入（usage 无缓存字段时为 0） */
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    /** usage 缺失时按估算（估算结果全部按未缓存输入计） */
    tokensEstimated: boolean('tokens_estimated').notNull().default(false),
    /** 官方价快照（元/百万 token，numeric 全精度） */
    inputPrice: numeric('input_price', { precision: 38, scale: 18 }).notNull().default('0'),
    outputPrice: numeric('output_price', { precision: 38, scale: 18 }).notNull().default('0'),
    cacheInputPrice: numeric('cache_input_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 费率卡系数快照（最终单价 = 官方价 × 系数） */
    coefficient: numeric('coefficient', { precision: 6, scale: 3 }).notNull(),
    /** 费用（元，numeric 全精度）；status=0 时 = plan_amount + payg_amount（实扣，余额可为负=欠款） */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 上游成本估算（元，官方价×实际用量快照；供应商对账数据基础） */
    upstreamCost: numeric('upstream_cost', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 套餐额度承担部分（默认 0） */
    planAmount: numeric('plan_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 余额承担部分（默认 0） */
    paygAmount: numeric('payg_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** plan / payg / both（同一请求套餐+余额混扣） */
    billedBy: varchar('billed_by', { length: 8 }).notNull(),
    subscriptionId: bigint('subscription_id', { mode: 'number' }).references(
      () => userSubscriptions.id,
    ),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
    status: smallint('status').notNull().default(1),
    stream: boolean('stream').notNull().default(false),
    /** 流式提前中断（客户端断开/上游中途失败），按已收内容估算计费 */
    streamAborted: boolean('stream_aborted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_logs_request_id_uq').on(t.requestId),
    index('usage_logs_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('usage_logs_model_created_idx').on(t.externalModel, t.createdAt),
    index('usage_logs_channel_created_idx').on(t.channelId, t.createdAt),
    index('usage_logs_subscription_idx').on(t.subscriptionId, t.createdAt),
  ],
);
