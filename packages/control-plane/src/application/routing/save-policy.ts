/**
 * 保存全局路由策略用例（管理写动词——经用例层而非 store 直通）：
 * 校验后的策略体 → 原子 upsert（version 自增）→ 审计（detail 携带完整策略
 * 快照 + 实际落库的版本/留痕——覆盖写之后旧策略仅存于审计，回滚依据）。
 */
import { emitAudit } from '../audit';
import type { DbLike } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { RoutingPolicyRecord, RoutingPolicyStore } from '../../ports/routing-policy-store';
import type { ControlContext } from '../context';
import { controlPlaneErrors } from '../../errors';

export interface SaveRoutingPolicyDeps {
  db: DbLike;
  stores: { routingPolicy: RoutingPolicyStore };
  audit: AuditSink;
}

export interface SaveRoutingPolicyUsecaseInput {
  /** routingPolicySchema.parse 后的策略体（admin-api 已校验） */
  policy: Record<string, unknown>;
  note?: string;
  ctx: ControlContext;
}

export async function saveRoutingPolicy(
  deps: SaveRoutingPolicyDeps,
  input: SaveRoutingPolicyUsecaseInput,
): Promise<{ version: string; savedAt: Date }> {
  let record: RoutingPolicyRecord;
  try {
    record = await deps.stores.routingPolicy.saveGlobal(deps.db, {
      policy: input.policy,
      ...(input.note != null ? { note: input.note } : {}),
      ...(input.ctx.actor.kind === 'admin' ? { updatedBy: `admin:${input.ctx.actor.id}` } : {}),
    });
  } catch (error) {
    // 落库失败统一翻译为目录错误；原始错误进 context 保留证据（不静默吞）
    throw controlPlaneErrors.business('routing_policy_save_failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  // 审计带完整策略快照（新策略覆盖旧后，旧版本仅存于此——管理台「查看上一版/回滚」的数据源）；
  // note/updatedBy 取实际落库值（未传时 store 保留旧值——审计与 DB 行一致）
  await emitAudit(deps.audit, {
    actor: input.ctx.actor.kind === 'admin' ? 'admin' : 'system',
    adminId: input.ctx.actor.kind === 'admin' ? input.ctx.actor.id : null,
    action: 'routing.policy_update',
    targetType: 'routing_policy',
    targetId: 'global',
    detail: {
      version: record.version,
      note: record.note,
      policy: input.policy,
      ...(record.updatedBy != null ? { updatedBy: record.updatedBy } : {}),
    },
  });
  return { version: record.version, savedAt: record.updatedAt };
}
