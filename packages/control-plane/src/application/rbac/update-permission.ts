/**
 * 更新资源节点（仅展示字段:name/i18n_key/description/icon/sort_order/status）:
 *  - code/type/父子/source 恒不可改（码即身份——改名 = 新建 + 重绑）;
 *  - enforced 节点不可停用（路由守卫在引用,停用 = 全站误伤）——permission_immutable;
 *  - custom 停用 = 该码 kill-switch。
 */
import { controlPlaneErrors } from '../../errors';
import type { PermissionNode } from '../../ports/rbac-store';
import type { UpdatePermissionRow } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

const MUTABLE_FIELDS: readonly (keyof UpdatePermissionRow)[] = [
  'name',
  'i18nKey',
  'description',
  'icon',
  'sortOrder',
  'status',
];

export async function updatePermission(
  deps: RbacDeps,
  input: UpdatePermissionRow,
): Promise<PermissionNode> {
  const node = await deps.stores.permission.findById(deps.db, input.id);
  if (node == null) {
    throw controlPlaneErrors.business('permission_not_found', { id: input.id });
  }
  if (input.status !== undefined && node.source === 'enforced') {
    throw controlPlaneErrors.business('permission_immutable', {
      id: node.id,
      reason: 'enforced nodes cannot be disabled',
    });
  }
  if (input.status !== undefined && input.status !== 0 && input.status !== 1) {
    throw controlPlaneErrors.business('invalid_permission_input', { status: input.status });
  }
  const patch: UpdatePermissionRow = { id: input.id };
  for (const field of MUTABLE_FIELDS) {
    if (input[field] !== undefined) {
      (patch as unknown as Record<string, unknown>)[field] = input[field];
    }
  }
  const updated = await deps.stores.permission.update(deps.db, patch);
  if (updated == null) {
    throw controlPlaneErrors.business('permission_not_found', { id: input.id });
  }
  return updated;
}
