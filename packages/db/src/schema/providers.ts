import { pgTable, bigserial, varchar, smallint, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** providers — 供应商（data-model.md §3.4） */
export const providers = pgTable(
  'providers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 32 }).notNull(),
    /**
     * 协议标识 = ai 包适配器注册表键（SUPPORTED_PROTOCOLS 单一真相，
     * admin-api 校验引用；当前仅 openai-compatible）。
     */
    protocol: varchar('protocol', { length: 32 }).notNull().default('openai-compatible'),
    /**
     * 厂商档案引用（可空）：ai 包 VENDOR_PROFILES 词表键——openai-compatible
     * 协议族的参数怪癖预设（如 openai 的 max_tokens→max_completion_tokens）。
     * 未声明 = 无档案（纯透传）；合法值由 admin-api 按 vendorProfileNames() 校验。
     */
    vendor: varchar('vendor', { length: 32 }),
    baseUrl: varchar('base_url', { length: 255 }).notNull(),
    /** 0 启用 / 1 禁用 */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('providers_name_uq').on(t.name)],
);
