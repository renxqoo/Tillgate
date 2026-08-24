/**
 * 创建角色：code 唯一（409 role_exists）→ 授权码全部须为活动权限（400 invalid_permission_code）
 * → 建行 + 授权落库（同事务）。is_super/is_builtin 只能由种子产生——创建面恒为自定义角色。
 */
import { controlPlaneErrors } from '../../errors';
import type { RoleRecord } from '../../ports/rbac-store';
import type { CreateRoleRow } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

const CODE_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

export async function createRole(deps: RbacDeps, input: CreateRoleRow): Promise<RoleRecord> {
  const code = input.code.trim().toLowerCase();
  if (!CODE_PATTERN.test(code) || input.name.trim() === '') {
    throw controlPlaneErrors.business('invalid_role_input', { code });
  }
  if (await deps.stores.role.findByCode(deps.db, code)) {
    throw controlPlaneErrors.business('role_exists', { code });
  }
  const active = new Set(await deps.stores.permission.activeCodes(deps.db));
  for (const granted of input.codes) {
    if (!active.has(granted)) {
      throw controlPlaneErrors.business('invalid_permission_code', { code: granted });
    }
  }
  return deps.db.transaction((tx) =>
    deps.stores.role.create(tx, {
      code,
      name: input.name.trim(),
      description: input.description,
      codes: input.codes,
    }),
  );
}
