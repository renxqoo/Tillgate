import { pgTable, bigserial, varchar, smallint, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** providers — 供应商（data-model.md §3.4） */
export const providers = pgTable(
  'providers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 32 }).notNull(),
    /** 一期全为 openai_compatible */
    protocol: varchar('protocol', { length: 32 }).notNull().default('openai_compatible'),
    baseUrl: varchar('base_url', { length: 255 }).notNull(),
    /** 0 启用 / 1 禁用 */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('providers_name_uq').on(t.name)],
);
