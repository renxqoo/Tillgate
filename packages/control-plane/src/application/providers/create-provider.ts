/**
 * 创建供应商：词表校验（协议/档案）→ 事务落库 → 审计。
 * 重名由 PG 唯一索引兜底（23505 → provider_exists 冲突）。
 */
import { isUniqueViolation, type Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ProviderStore, ProviderRecord } from '../../ports/provider-store';
import type { ProviderCapabilities, ProviderCreateInput } from '../../domain/provider/provider';
import { validateProviderCreate } from '../../domain/provider/provider';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';

export interface CreateProviderDeps {
  readonly db: Db;
  readonly stores: { readonly provider: ProviderStore };
  readonly capabilities: ProviderCapabilities;
  /** 协议缺省（装配注入——铁律 3，不藏全局默认） */
  readonly defaultProtocol: string;
  readonly audit: AuditSink;
}

export type CreateProviderInput = {
  readonly ctx: ControlContext;
} & ProviderCreateInput;

export async function createProvider(
  deps: CreateProviderDeps,
  input: CreateProviderInput,
): Promise<ProviderRecord> {
  const { ctx, ...rest } = input;
  const validated = validateProviderCreate(deps.capabilities, rest, deps.defaultProtocol);
  let row: ProviderRecord;
  try {
    row = await deps.db.transaction((tx) => deps.stores.provider.insert(tx, validated));
  } catch (error) {
    // 重名交给唯一索引（并发下前置查重有窗口，索引是结构兜底）
    if (isUniqueViolation(error)) {
      throw controlPlaneErrors.business('provider_exists', { name: validated.name });
    }
    throw error;
  }
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(ctx),
    action: 'provider.create',
    targetType: 'provider',
    targetId: row.id,
    detail: { name: row.name, protocol: row.protocol, baseUrl: row.baseUrl },
  });
  return row;
}
