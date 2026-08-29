import { pgTable, bigserial, varchar, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * routing_policies — 智能路由策略（热配置唯一持久面）
 * scope='global' 单行；mapping 级覆写预留 scope='mapping:{id}'（字段级 merge
 * 覆盖全局）。policy JSONB 形状单一真相在 packages/inference 的
 * routingPolicySchema（写侧 zod 校验，坏值拒绝落库；读侧解析失败沿用上一份
 * 好值）。version 每次保存自增（观测/回滚锚点）；gateway TTL reader 拾取
 * （≤15s 生效，不重启）。
 */
export const routingPolicies = pgTable(
  'routing_policies',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 'global' | 'mapping:{mappingId}' */
    scope: varchar('scope', { length: 64 }).notNull(),
    /** 策略版本号（应用层保存时自增——展示与回滚锚点） */
    version: varchar('version', { length: 32 }).notNull(),
    /** routingPolicySchema 形状的策略体（scorers/retry/penalty/modelDead/wait） */
    policy: jsonb('policy').$type<Record<string, unknown>>().notNull(),
    /** 编辑留痕（管理台备注） */
    note: varchar('note', { length: 255 }),
    updatedBy: varchar('updated_by', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('routing_policies_scope_uq').on(t.scope)],
);
