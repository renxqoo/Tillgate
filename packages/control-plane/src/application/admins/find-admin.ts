/** 按 id 查管理员资料（会话属主回查/GET /v1/me 消费）;授权策略在 app 裁决 */
import type { AdminRecord } from '../../ports/admin-store';
import type { AdminsDeps } from './admins-shared';

export function findAdmin(deps: AdminsDeps, id: number): Promise<AdminRecord | null> {
  return deps.store.findById(deps.db, id);
}
