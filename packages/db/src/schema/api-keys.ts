import { pgTable, bigserial, varchar, smallint, timestamp, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { apps } from './apps.js'

/**
 * api_keys — 虚拟 Key（data-model.md §3.3）
 * 安全设计：明文 Key 不落库——只存 SHA-256(key_hash) + 展示用 key_preview
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
    name: varchar('name', { length: 64 }).notNull(),
    remark: varchar('remark', { length: 255 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Key 级限流，NULL=继承用户/全局 */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
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
  ],
)
