import { jsonb } from './jsonb.js';
import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  smallint,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { userSubscriptions } from './plans.js';

/** apps — 应用（企业 Agent 凭证，JWT 签发方） */
export const apps = pgTable(
  'apps',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    appId: varchar('app_id', { length: 32 }).notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    /** SHA-256；明文仅创建/轮换时展示一次 */
    clientSecretHash: varchar('client_secret_hash', { length: 64 }).notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    description: varchar('description', { length: 255 }),
    /** 计费来源：NULL=余额；非空=扣该订阅额度（与 key 同规则）。 */
    subscriptionId: bigint('subscription_id', { mode: 'number' }).references(
      () => userSubscriptions.id,
    ),
    /** 限制项（可选）：{ models: [], rpm: N, tpm: N } */
    scope: jsonb('scope').$type<{ models?: string[]; rpm?: number; tpm?: number }>(),
    /** 0 启用 / 1 禁用 */
    status: smallint('status').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('apps_app_id_uq').on(t.appId),
    uniqueIndex('apps_client_id_uq').on(t.clientId),
    index('apps_user_id_idx').on(t.userId),
    index('apps_subscription_id_idx').on(t.subscriptionId),
  ],
);
