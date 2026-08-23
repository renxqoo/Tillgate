/**
 * 恢复已删除的供应商（回收站取出）：deleted_at→NULL，status 固定回 1（禁用态）——
 * 不直接启用，复核后由管理员显式启用。仅已删除行可恢复；在册行走常规 PATCH（此处 404）。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ProviderStore } from '../../ports/provider-store';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface UndeleteProviderDeps {
  readonly db: Db;
  readonly stores: { readonly provider: ProviderStore };
  readonly audit: AuditSink;
}

export interface UndeleteProviderInput {
  readonly ctx: ControlContext;
  readonly providerId: number;
}

export async function undeleteProvider(
  deps: UndeleteProviderDeps,
  input: UndeleteProviderInput,
): Promise<{ ok: true }> {
  const ok = await deps.stores.provider.restore(deps.db, { providerId: input.providerId });
  if (!ok) {
    throw controlPlaneErrors.business('provider_not_found', { providerId: input.providerId });
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: 'provider.undelete',
    targetType: 'provider',
    targetId: input.providerId,
  });
  return { ok: true as const };
}
