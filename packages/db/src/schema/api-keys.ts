import {
  pgTable,
  bigserial,
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
import { userSubscriptions } from './plans.js';

/**
 * api_keys — 虚拟 Key（data-model.md §3.3）
 * 安全设计：明文 Key 不落库——只存 SHA-256(key_hash) + 展示用 key_preview
 *
 * 计费来源（org/member 模型）：`subscription_id` 显式绑定「用哪个计费账户」。
 *   - NULL = 用成员自己的余额（payg）。
 *   - 非空 = 扣该订阅额度（个人订阅 / 所属组织的订阅）。
 * key 归属成员本人（user_id），数量自由；换额度 = 换绑不同 subscription_id 的 key。
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** SHA-256(完整 Key)，鉴权时对请求 Key 哈希后查询 */
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    /** 展示用：ag_****abcd（末 4 位） */
    keyPreview: varchar('key_preview', { length: 40 }).notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    appId: bigint('app_id', { mode: 'number' }).references(() => apps.id),
    /** 计费来源：NULL=余额；非空=扣该订阅额度。authorize 直读此列（单一真相）。 */
    subscriptionId: bigint('subscription_id', { mode: 'number' }).references(
      () => userSubscriptions.id,
    ),
    name: varchar('name', { length: 64 }).notNull(),
    remark: varchar('remark', { length: 255 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Key 级限流，NULL=继承用户/全局 */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    /**
     * Key 级每日花费上限（元，NULL=不限）。团队场景：一个用户（团队）挂多个 Key（团员），
     * 管理员可对单个团员 Key 单独设「单日最多消费」；独立于用户级 daily_spend_limit，两者都设时双闸门。
     */
    dailySpendLimit: numeric('daily_spend_limit', { precision: 38, scale: 18 }),
    /**
     * 包月额度耗尽是否自动转 PAYG 扣余额（开关式排他，funding-package-plan §3.6）：
     * false（默认）= 额度不足整单拒绝（存量行为零变化）；true = 订阅出余量 + 余额补差。
     * 创建 Key 时设置（client-api 职责）；gateway 经凭证解析只读。App JWT 无此开关（恒 false）。
     */
    allowPaygFallback: boolean('allow_payg_fallback').notNull().default(false),
    /** 0 有效 / 1 吊销 */
    status: smallint('status').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_uq').on(t.keyHash),
    index('api_keys_user_id_idx').on(t.userId),
    index('api_keys_app_id_idx').on(t.appId),
    index('api_keys_subscription_id_idx').on(t.subscriptionId),
  ],
);
