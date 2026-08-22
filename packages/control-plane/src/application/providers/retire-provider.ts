/**
 * 退役供应商：软删（status=1，历史渠道引用不受影响）。0 行 = 不存在。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ProviderStore } from '../../ports/provider-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface RetireProviderDeps {
  readonly db: Db;
  readonly stores: { readonly provider: ProviderStore };
  readonly audit: AuditSink;
}

export interface RetireProviderInput {
  readonly ctx: ControlContext;
  readonly providerId: number;
}

export async function retireProvider(
  deps: RetireProviderDeps,
  input: RetireProviderInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.provider.retire(deps.db, { providerId: input.providerId });
  if (!ok) {
    throw controlPlaneErrors.business('provider_not_found', { providerId: input.providerId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'provider.retire',
    targetType: 'provider',
    targetId: input.providerId,
  });
  return { ok: true as const };
}
