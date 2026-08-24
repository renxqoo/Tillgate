/**
 * 创建资源节点（恒为 custom——enforced 只由种子产生）:
 *  - code 全局唯一（permission_code_taken;button 必须有码,group 必须无码）;
 *  - button 必须挂 page 下;page 必须挂 group 下;group 顶层;
 *  - page 可无码（全员可见形态,仅 dashboard 种子）;custom page 必须有码。
 */
import { controlPlaneErrors } from '../../errors';
import type { PermissionNode } from '../../ports/rbac-store';
import type { CreatePermissionRow } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,30}:[a-z][a-z0-9_-]{1,31}$/;

export async function createPermission(
  deps: RbacDeps,
  input: CreatePermissionRow,
): Promise<PermissionNode> {
  if (input.name.trim() === '') {
    throw controlPlaneErrors.business('invalid_permission_input', {});
  }
  if (input.type === 'button' && (input.code == null || !CODE_PATTERN.test(input.code))) {
    throw controlPlaneErrors.business('invalid_permission_input', { code: input.code ?? null });
  }
  if (input.type === 'page' && input.code != null && !CODE_PATTERN.test(input.code)) {
    throw controlPlaneErrors.business('invalid_permission_input', { code: input.code });
  }
  // 唯一性仅约束按钮（页面共享域读码合法——同 update-permission 口径）
  if (
    input.type === 'button' &&
    input.code != null &&
    (await deps.stores.permission.codeTaken(deps.db, input.code))
  ) {
    throw controlPlaneErrors.business('permission_code_taken', { code: input.code });
  }
  if (input.parentId != null) {
    const parent = await deps.stores.permission.findById(deps.db, input.parentId);
    if (parent == null) {
      throw controlPlaneErrors.business('permission_not_found', { id: input.parentId });
    }
    const expected = input.type === 'button' ? 'page' : 'group';
    if (parent.type !== expected) {
      throw controlPlaneErrors.business('invalid_permission_input', {
        parentType: parent.type,
        expected,
      });
    }
  } else if (input.type !== 'group') {
    throw controlPlaneErrors.business('invalid_permission_input', { parentRequired: input.type });
  }
  return deps.stores.permission.create(deps.db, {
    ...input,
    name: input.name.trim(),
    code: input.type === 'group' ? null : input.code,
  });
}
