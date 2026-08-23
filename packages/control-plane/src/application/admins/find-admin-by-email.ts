/** 按邮箱查管理员资料（登录编排消费——密码鉴别在 identity,此处只取资料事实） */
import type { AdminRecord } from '../../ports/admin-store';
import type { AdminsDeps } from './admins-shared';

export function findAdminByEmail(deps: AdminsDeps, email: string): Promise<AdminRecord | null> {
  return deps.store.findByEmail(deps.db, email.trim().toLowerCase());
}
