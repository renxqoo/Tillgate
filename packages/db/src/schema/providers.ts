import { pgTable, bigserial, varchar, smallint, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** providers — 供应商 */
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
    /**
     * 记录面逻辑删除（回收站）：NULL = 在册；非空 = 已删除（历史渠道 FK 引用不受影响）。
     * 删除同时强制 status=1；恢复记录回到禁用态。名称唯一约束为部分索引——
     * 已删除记录不占用名称，可重建同名供应商。
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 部分唯一：仅约束在册记录——逻辑删除后名称释放，可重建同名
    uniqueIndex('providers_name_uq')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
  ],
);
