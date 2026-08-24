/** facade rbac 面装配（ADR-0008）——从 control-plane.ts 抽出以守 500 行指引 */
import type { Db } from '@tokenlens/db';
import type {
  CreatePermissionRow,
  CreateRoleRow,
  PermissionNode,
  RoleListQuery,
  RoleListResult,
  RoleRecord,
  UpdatePermissionRow,
  UpdateRoleRow,
} from '../../ports/rbac-store';
import type { EndpointStore, PermissionStore, RoleStore } from '../../ports/rbac-store';
import { listRoles } from './list-roles';
import { createRole } from './create-role';
import { updateRole } from './update-role';
import { deleteRole } from './delete-role';
import { treePermissions } from './tree-permissions';
import { createPermission } from './create-permission';
import { updatePermission } from './update-permission';
import { deletePermission } from './delete-permission';
import { listEndpoints } from './list-endpoints';
import { createEndpointBinding } from './create-endpoint-binding';
import { rebindEndpoint } from './rebind-endpoint';
import { deleteEndpointBinding } from './delete-endpoint-binding';
import type { CreateEndpointRow, EndpointBindingRecord } from '../../ports/rbac-store';

export interface RbacSurface {
  readonly roles: {
    find(roleId: number): Promise<RoleRecord | null>;
    list(query: RoleListQuery): Promise<RoleListResult>;
    create(input: CreateRoleRow): Promise<RoleRecord>;
    update(
      input: UpdateRoleRow,
    ): Promise<ReturnType<typeof updateRole> extends Promise<infer R> ? R : never>;
    remove(roleId: number): Promise<{ ok: true }>;
  };
  readonly permissions: {
    tree(): Promise<PermissionNode[]>;
    create(input: CreatePermissionRow): Promise<PermissionNode>;
    update(input: UpdatePermissionRow): Promise<PermissionNode>;
    remove(id: number): Promise<{ ok: true }>;
    activeCodes(): Promise<string[]>;
  };
  readonly endpoints: {
    list(): Promise<EndpointBindingRecord[]>;
    create(input: CreateEndpointRow): Promise<EndpointBindingRecord>;
    rebind(id: number, permissionId: number): Promise<EndpointBindingRecord>;
    remove(id: number): Promise<{ ok: true }>;
  };
}

export function composeRbacSurface(
  db: Db,
  stores: { role: RoleStore; permission: PermissionStore; endpoint: EndpointStore },
): RbacSurface {
  const deps = { db, stores };
  return {
    roles: {
      find: (roleId) => stores.role.findById(db, roleId),
      list: (query) => listRoles(deps, query),
      create: (input) => createRole(deps, input),
      update: (input) => updateRole(deps, input),
      remove: (roleId) => deleteRole(deps, roleId),
    },
    permissions: {
      tree: () => treePermissions(deps),
      create: (input) => createPermission(deps, input),
      update: (input) => updatePermission(deps, input),
      remove: (id) => deletePermission(deps, id),
      activeCodes: () => stores.permission.activeCodes(db),
    },
    endpoints: {
      list: () => listEndpoints(deps),
      create: (input) => createEndpointBinding(deps, input),
      rebind: (id, permissionId) => rebindEndpoint(deps, id, permissionId),
      remove: (id) => deleteEndpointBinding(deps, id),
    },
  };
}
