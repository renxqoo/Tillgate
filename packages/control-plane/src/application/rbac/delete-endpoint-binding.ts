/**
 * 解绑：解绑后该接口默认拒绝（fail-closed——除超管外全 403,直到重新绑定）。
 * 这正是「解绑 = 显式下线」的语义,管理面确认弹窗承担告知。
 */
import { controlPlaneErrors } from '../../errors';
import type { RbacDeps } from './rbac-shared';

export async function deleteEndpointBinding(deps: RbacDeps, id: number): Promise<{ ok: true }> {
  const rows = await deps.stores.endpoint.list(deps.db);
  if (!rows.some((row) => row.id === id)) {
    throw controlPlaneErrors.business('endpoint_not_found', { id });
  }
  await deps.stores.endpoint.remove(deps.db, id);
  return { ok: true };
}
