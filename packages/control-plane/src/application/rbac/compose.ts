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
import type { PermissionStore, RoleStore } from '../../ports/rbac-store';
import { listRoles } from './list-roles';
import { createRole } from './create-role';
import { updateRole } from './update-role';
import { deleteRole } from './delete-role';
import { treePermissions } from './tree-permissions';
import { createPermission } from './create-permission';
import { updatePermission } from './update-permission';
import { deletePermission } from './delete-permission';

export interface RbacSurface {
  readonly roles: {
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
}

export function composeRbacSurface(
  db: Db,
  stores: { role: RoleStore; permission: PermissionStore },
): RbacSurface {
  const deps = { db, stores };
  return {
    roles: {
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
  };
}
