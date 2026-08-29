/**
 * routing_policies postgres 适配器：策略热配置的持久面读写。
 * 读侧消费方 = 网关 TTL reader（经 gateway 装配）与管理台展示；写侧 =
 * 管理台保存（zod 校验后的策略体，version 自增，留痕 note/updatedBy）。
 * scope='global' 单行 upsert；mapping 覆写行预留（scope='mapping:{id}'，
 * 网关 reader 的 merge 语义后续波次接入）。
 */
import { eq, sql } from 'drizzle-orm';
import { routingPolicies } from '@tillgate/db';
import type { RoutingPolicyRecord, RoutingPolicyStore } from '../../ports/routing-policy-store';

export const GLOBAL_SCOPE = 'global';

export const postgresRoutingPolicyStore: RoutingPolicyStore = {
  async findGlobal(db) {
    const row = await db.query.routingPolicies.findFirst({
      where: eq(routingPolicies.scope, GLOBAL_SCOPE),
    });
    return row == null ? null : toRecord(row);
  },

  async saveGlobal(db, input) {
    // 单语句原子 upsert：并发保存无丢失更新（后写覆盖前写且各自拿到不同自增版本）
    const rows = await db
      .insert(routingPolicies)
      .values({
        scope: GLOBAL_SCOPE,
        version: '1',
        policy: input.policy,
        ...(input.note != null ? { note: input.note } : {}),
        ...(input.updatedBy != null ? { updatedBy: input.updatedBy } : {}),
      })
      .onConflictDoUpdate({
        target: routingPolicies.scope,
        set: {
          version: sql`(${routingPolicies.version}::bigint + 1)::text`,
          policy: input.policy,
          updatedAt: new Date(),
          ...(input.note != null ? { note: input.note } : {}),
          ...(input.updatedBy != null ? { updatedBy: input.updatedBy } : {}),
        },
      })
      .returning();
    const [row] = rows;
    // RETURNING 空行不是合法状态（不假成功）——由用例层翻译为业务错误
    if (row == null) throw new Error('routing_policy.upsert_returned_no_row');
    return toRecord(row);
  },
};

function toRecord(row: typeof routingPolicies.$inferSelect): RoutingPolicyRecord {
  return {
    id: row.id,
    scope: row.scope,
    version: row.version,
    policy: row.policy,
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
