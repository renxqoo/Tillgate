/**
 * 单笔预估敞口上限写（admin settings 面）：upsert + 审计。生效节奏 = 网关 TTL 缓存
 * 过期。值域由 billing 解析单一实现兜底（正十进制——0/负上限 = 无限放行，禁）。
 */
import { BILLING_RESERVATION_LIMIT_KEY, parseReservationLimitSetting } from '@tillgate/billing';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SettingsStore } from '../../ports/settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateBillingReservationLimitDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
  readonly audit: AuditSink;
}

export interface UpdateBillingReservationLimitInput {
  readonly ctx: ControlContext;
  readonly limit: string;
}

export async function updateBillingReservationLimit(
  deps: UpdateBillingReservationLimitDeps,
  input: UpdateBillingReservationLimitInput,
): Promise<{ limit: string }> {
  if (parseReservationLimitSetting({ limit: input.limit }) === null) {
    throw controlPlaneErrors.business('invalid_reservation_limit', { limit: input.limit });
  }
  const adminId = adminIdOf(input.ctx);
  await deps.stores.settings.updateBillingReservationLimit(deps.db, {
    limit: input.limit,
    adminId,
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'settings.billing_reservation_limit',
    targetType: 'system_config',
    targetId: BILLING_RESERVATION_LIMIT_KEY,
    detail: { limit: input.limit },
  });
  return { limit: input.limit };
}
