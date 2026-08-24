/**
 * 更新供应商：补丁词表校验 → 落库 → 审计。0 行 = 不存在。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ProviderStore, ProviderRecord } from '../../ports/provider-store';
import type { ProviderCapabilities, ProviderPatchInput } from '../../domain/provider/provider';
import { validateProviderPatch } from '../../domain/provider/provider';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UpdateProviderDeps {
  readonly db: Db;
  readonly stores: { readonly provider: ProviderStore };
  readonly capabilities: ProviderCapabilities;
  readonly audit: AuditSink;
}

export interface UpdateProviderInput {
  readonly ctx: ControlContext;
  readonly providerId: number;
  readonly patch: ProviderPatchInput;
}

export async function updateProvider(
  deps: UpdateProviderDeps,
  input: UpdateProviderInput,
): Promise<ProviderRecord> {
  const patch = validateProviderPatch(deps.capabilities, input.patch);
  const row = await deps.stores.provider.update(deps.db, { providerId: input.providerId, patch });
  if (!row) {
    throw controlPlaneErrors.business('provider_not_found', { providerId: input.providerId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'provider.update',
    targetType: 'provider',
    targetId: row.id,
    detail: { patch: input.patch },
  });
  return row;
}
