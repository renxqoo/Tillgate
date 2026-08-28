/**
 * 预扣策略写（admin settings 面）：upsert + 审计。生效节奏 = 网关 TTL 缓存过期
 * （分钟内全网关拾取，无需重启）。值域由 billing 解析单一实现兜底
 * （路由契约 zod 之外的二道防线——fixed 金额必须为正）。
 */
import {
  BILLING_RESERVATION_POLICY_KEY,
  parseReservationPolicySetting,
} from '@tillgate/billing';
import { controlPlaneErrors } from '../../errors';
import type { Db } from '@tillgate/db';
import type { FundingReservationPolicy } from '@tillgate/billing';
import type { AuditSink } from '../../ports/audit-sink';
import type { SettingsStore } from '../../ports/settings-store';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateBillingReservationDeps {
  readonly db: Db;
  readonly stores: { readonly settings: SettingsStore };
  readonly audit: AuditSink;
}

export interface UpdateBillingReservationInput {
  readonly ctx: ControlContext;
  readonly policy: FundingReservationPolicy;
}

export async function updateBillingReservation(
  deps: UpdateBillingReservationDeps,
  input: UpdateBillingReservationInput,
): Promise<{ policy: FundingReservationPolicy }> {
  if (parseReservationPolicySetting(input.policy) === null) {
    throw controlPlaneErrors.business('invalid_reservation_policy', {
      policy: JSON.stringify(input.policy),
    });
  }
  const adminId = adminIdOf(input.ctx);
  await deps.stores.settings.updateBillingReservationPolicy(deps.db, {
    policy: input.policy,
    adminId,
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'settings.billing_reservation',
    targetType: 'system_config',
    targetId: BILLING_RESERVATION_POLICY_KEY,
    detail: input.policy as Record<string, unknown>,
  });
  return { policy: input.policy };
}
