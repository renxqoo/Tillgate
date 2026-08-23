/**
 * admin-api BFF client 工厂（app 唯一取数出口）。
 *
 * 每请求经 createNextAdminApiClient() 新建：会话 token/出口头（accept-language、
 * x-forwarded-for）由 api-client/next 装配注入；基地址 env ADMIN_API_BASE（dev 兜底
 * http://localhost:8082）。页面与 server action 一律经 `adminApi()` 取数——
 * 禁止裸 fetch 直连 admin-api（登录/验码除外：会话建立前无 client，见 auth-actions）。
 */
import type { AdminApiClient } from '@tokenlens/api-client';

import { createNextAdminApiClient } from '@tokenlens/api-client/next';

export function adminApi(): AdminApiClient {
  return createNextAdminApiClient();
}
