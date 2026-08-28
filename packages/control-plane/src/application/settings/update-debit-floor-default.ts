/**
 * 透支地板默认写（admin settings 面）：upsert + 审计。
 * 即时生效节奏 = 消费方读取点（billing 建户套默认、admin 批量刷默认均现读现用，
 * 无缓存）。值域由 billing 的解析单一实现兜底（路由契约 zod 之外的二道防线）。
 */
import { DEBIT_FLOOR_DEFAULT_KEY, parseDebitFloorDefault } from '@tillgate/billing';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SettingsStore } from '../../ports/settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateDebitFloorDefaultDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
  readonly audit: AuditSink;
}

export interface UpdateDebitFloorDefaultInput {
  readonly ctx: ControlContext;
  readonly floor: string;
}

export async function updateDebitFloorDefault(
  deps: UpdateDebitFloorDefaultDeps,
  input: UpdateDebitFloorDefaultInput,
): Promise<{ floor: string }> {
  if (parseDebitFloorDefault({ floor: input.floor }) === null) {
    throw controlPlaneErrors.business('invalid_debit_floor', { floor: input.floor });
  }
  const adminId = adminIdOf(input.ctx);
  await deps.stores.settings.updateDebitFloorDefault(deps.db, {
    floor: input.floor,
    adminId,
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'settings.debit_floor_default',
    targetType: 'system_config',
    targetId: DEBIT_FLOOR_DEFAULT_KEY,
    detail: { floor: input.floor },
  });
  return { floor: input.floor };
}
