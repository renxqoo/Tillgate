import { pgTable, bigserial, bigint, varchar, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * reconcile_discrepancies — 对账差异记录（data-model.md §3.16，重构新增）。
 *
 * 对账作业（worker/reconcile.ts）发现账本不平时写入：
 *   - 用户级：sum(usage_logs.amount) + 充值 与 余额变动 不一致
 *   - 平台级：sum(upstream_cost) 累计统计异常
 *   - 每条记录差异维度、期望值、实际值、容差，供运维/财务核查。
 *
 * 对账是独立于主链路的护栏（金融级标配），不阻塞计费，只告警+留痕。
 */
export const reconcileDiscrepancies = pgTable(
  'reconcile_discrepancies',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 维度：user / platform / hold */
    scope: varchar('scope', { length: 16 }).notNull(),
    /** scope=user 时为 userId，否则 null */
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
    /** 期望值（元，全精度） */
    expected: numeric('expected', { precision: 38, scale: 18 }).notNull(),
    /** 实际值（元，全精度） */
    actual: numeric('actual', { precision: 38, scale: 18 }).notNull(),
    /** 差额（actual - expected，元） */
    diff: numeric('diff', { precision: 38, scale: 18 }).notNull(),
    /** 详情（检查项、时间窗口等 JSON） */
    detail: varchar('detail', { length: 512 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reconcile_user_created_idx').on(t.userId, t.createdAt),
    index('reconcile_scope_created_idx').on(t.scope, t.createdAt),
  ],
);
