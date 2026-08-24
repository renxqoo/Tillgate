/**
 * 创建管理员资料行（POST /v1/admins 的第一半;第二半 = identity 凭据注册,编排与
 * 失败补偿在 admin-api 路由——两包间无共享事务边界,补偿语义见 docs/admin-rbac）。
 * 角色词表守卫在此;重名由 admins_email_uq 兜底（23505 → admin_email_taken）。
 * 审计由编排方在双动词全部成功后旁路记录（postAudit——两步全成才算「创建」）。
 */
import { isUniqueViolation, type Db } from '@tillgate/db';
import { controlPlaneErrors } from '../../errors';
import type { AdminRecord, AdminStore } from '../../ports/admin-store';

export interface CreateAdminInput {
  readonly email: string;
  readonly displayName: string | null;
  readonly roleId: number;
}

export async function createAdmin(
  deps: { db: Db; store: AdminStore },
  input: CreateAdminInput,
): Promise<AdminRecord> {
  const email = input.email.trim().toLowerCase();
  if (!Number.isInteger(input.roleId) || input.roleId < 1) {
    throw controlPlaneErrors.business('invalid_role_input', { roleId: input.roleId });
  }
  try {
    // id 段分配 + 插入同事务（adapter 内分配;Db 全量形态——事务动词在 Db 上）
    return await deps.db.transaction((tx) =>
      deps.store.create(tx, { email, displayName: input.displayName, roleId: input.roleId }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw controlPlaneErrors.business('admin_email_taken', { email });
    }
    throw error;
  }
}
