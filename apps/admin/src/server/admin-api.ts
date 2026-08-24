/**
 * admin-api BFF client 工厂（app 唯一取数出口）。
 *
 * 每请求经 createNextAdminApiClient() 新建：会话 token/出口头（accept-language、
 * x-forwarded-for）由 api-client/next 装配注入；基地址 env ADMIN_API_BASE（dev 兜底
 * http://localhost:8082）。页面与 server action 一律经 `adminApi()` 取数——
 * 禁止裸 fetch 直连 admin-api（登录/验码除外：会话建立前无 client，见 auth-actions）。
 */
import type { AdminApiClient } from '@tillgate/api-client';

import { createNextAdminApiClient } from '@tillgate/api-client/next';

import { ADMIN_LOCALE_RESOLUTION } from './admin-locale';

export function adminApi(): AdminApiClient {
  // BFF 出口语言与 UI 同源策略(cookie → zh),API 错误 message 语言随界面
  return createNextAdminApiClient({ localeResolution: ADMIN_LOCALE_RESOLUTION });
}
