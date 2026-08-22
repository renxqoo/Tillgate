/**
 * admin-api(管理面)facade:core transport + 管理面 DTO 快照 + getAdminMe 布局守卫。
 *
 * 双后端物理隔离:
 *   - admin-api(管理面,端口 8082):/v1/providers、/v1/channels、/v1/models、
 *     /v1/users、/v1/plans、/v1/channel-funds、/v1/billing-operations、/v1/tracing 等
 * 会话 token 来源由装配方显式注入(B1 回归:v1 按基地址比较挑选 token 源已废除)。
 */
import {
  createHttpClient,
  type HeaderGetter,
  type HttpClient,
  type TokenGetter,
} from './core/client';
import type { AdminMeInfo } from './dto/admin-api';

export interface AdminApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getToken?: TokenGetter;
  getHeaders?: HeaderGetter;
}

export interface AdminApiClient extends HttpClient {
  /**
   * 调用 /v1/me,失败返回 null(用于 apps/admin 的 layout 守卫;v1 getAdminMe 行为等价)。
   * 能拿到即证明持有效管理员会话(admin-api 已用 adminAuthMiddleware 守护)。
   */
  getAdminMe(): Promise<AdminMeInfo | null>;
}

export function createAdminApiClient(options: AdminApiClientOptions): AdminApiClient {
  const http = createHttpClient(options);
  return {
    ...http,
    async getAdminMe(): Promise<AdminMeInfo | null> {
      try {
        return await http.get<AdminMeInfo>('/v1/me');
      } catch {
        return null;
      }
    },
  };
}
