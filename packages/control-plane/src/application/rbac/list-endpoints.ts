/** 接口绑定清单（管理面 + ACL 中间件消费同一动词——中间件走 store 直查经 facade 装配） */
import type { EndpointBindingRecord } from '../../ports/rbac-store';
import type { RbacDeps } from './rbac-shared';

export function listEndpoints(deps: RbacDeps): Promise<EndpointBindingRecord[]> {
  return deps.stores.endpoint.list(deps.db);
}
