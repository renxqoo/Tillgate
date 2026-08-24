/**
 * 更新接口绑定（部分字段:method/path/permissionId,至少一项由契约层 refine 兜底）。
 * 守卫:终态 (method, path) 撞其他绑定 → 409 endpoint_bound（排除自身）;权限节点须存在
 * （绑到停用码 = 该接口对非超管全体拒绝,允许——与创建同口径,只拦不存在）。
 */
import { controlPlaneErrors } from '../../errors';
import type { EndpointBindingRecord, UpdateEndpointRow } from '../../ports/rbac-store';
import { ENDPOINT_PATH_PATTERN } from './rbac-shared';
import type { RbacDeps } from './rbac-shared';

export async function updateEndpointBinding(
  deps: RbacDeps,
  id: number,
  input: UpdateEndpointRow,
): Promise<EndpointBindingRecord> {
  const existing = await deps.stores.endpoint.list(deps.db);
  const current = existing.find((row) => row.id === id);
  if (current == null) {
    throw controlPlaneErrors.business('endpoint_not_found', { id });
  }
  if (input.path !== undefined && !ENDPOINT_PATH_PATTERN.test(input.path)) {
    throw controlPlaneErrors.business('invalid_endpoint_input', { path: input.path });
  }
  if (input.permissionId !== undefined) {
    const permission = await deps.stores.permission.findById(deps.db, input.permissionId);
    if (permission == null) {
      throw controlPlaneErrors.business('permission_not_found', { id: input.permissionId });
    }
  }
  const method = input.method ?? current.method;
  const path = input.path ?? current.path;
  if (existing.some((row) => row.id !== id && row.method === method && row.path === path)) {
    throw controlPlaneErrors.business('endpoint_bound', { method, path });
  }
  const updated = await deps.stores.endpoint.update(deps.db, id, input);
  if (updated == null) {
    throw controlPlaneErrors.business('endpoint_not_found', { id });
  }
  return updated;
}
