/** 管理员列表（GET /v1/admins;id 升序,不分页——DESIGN D7）;授权策略在 app 裁决 */
import type { AdminRecord } from '../../ports/admin-store';
import type { AdminsDeps } from './admins-shared';

export function listAdmins(deps: AdminsDeps): Promise<AdminRecord[]> {
  return deps.store.list(deps.db);
}
