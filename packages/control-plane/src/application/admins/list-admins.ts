/** 管理员列表（GET /v1/admins;统一列表契约——分页/q/排序白名单在 app 层裁决） */
import type { AdminListQuery, AdminListResult } from '../../ports/admin-store';
import type { AdminsDeps } from './admins-shared';

export function listAdmins(deps: AdminsDeps, query: AdminListQuery): Promise<AdminListResult> {
  return deps.store.list(deps.db, query);
}
