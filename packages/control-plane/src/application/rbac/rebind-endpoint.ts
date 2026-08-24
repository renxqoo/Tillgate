/** 换绑（method+path 不变,改挂权限节点——下一请求生效）。 */
import { controlPlaneErrors } from '../../errors';
import type { EndpointBindingRecord } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

export async function rebindEndpoint(
  deps: RbacDeps,
  id: number,
  permissionId: number,
): Promise<EndpointBindingRecord> {
  const permission = await deps.stores.permission.findById(deps.db, permissionId);
  if (permission == null) {
    throw controlPlaneErrors.business('permission_not_found', { id: permissionId });
  }
  const updated = await deps.stores.endpoint.rebind(deps.db, id, permissionId);
  if (updated == null) {
    throw controlPlaneErrors.business('endpoint_not_found', { id });
  }
  return updated;
}
