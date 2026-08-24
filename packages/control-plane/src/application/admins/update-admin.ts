/**
 * 更新管理员资料（PATCH /v1/admins/:id 的用例半场）：角色词表守卫 + 部分更新。
 * 「不可改自身 role/status」守卫在路由层（会话身份是 app 的知识,use case 不藏）;
 * 未命中返回 null（404 抛点在路由——admin.admin_not_found 单一码）;
 * 审计由编排方旁路记录（postAudit）。
 */
import { controlPlaneErrors } from '../../errors';
import type { AdminRecord, UpdateAdminRow } from '../../ports/admin-store';
import type { AdminsDeps } from './admins-shared';

export async function updateAdmin(
  deps: AdminsDeps,
  input: UpdateAdminRow,
): Promise<AdminRecord | null> {
  if (input.roleId !== undefined && (!Number.isInteger(input.roleId) || input.roleId < 1)) {
    throw controlPlaneErrors.business('invalid_role_input', { roleId: input.roleId });
  }
  const patch: UpdateAdminRow = {
    adminId: input.adminId,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };

  const updated = await deps.store.update(deps.db, patch);
  return updated;
}
