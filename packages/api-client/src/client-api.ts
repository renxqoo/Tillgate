/**
 * client-api(用户面)facade:core transport + 用户面 DTO 快照 + getMe 布局守卫。
 *
 * 双后端物理隔离:
 *   - client-api(用户面,端口 8081):/v1/me、/v1/keys、/v1/apps、/v1/usage、
 *     /v1/redeem、/v1/auth/*、/v1/wallet/*、/v1/subscriptions、/v1/orgs、/v1/payments
 * 会话 token 来源由装配方显式注入(不按基地址挑选 token 源)。
 */
import {
  createHttpClient,
  type HeaderGetter,
  type HttpClient,
  type TokenGetter,
} from './core/client';
import type { MeInfo } from './dto/client-api';

export type { ApiFetchOptions } from './core/client';

export interface ClientApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getToken?: TokenGetter;
  getHeaders?: HeaderGetter;
}

export interface ClientApiClient extends HttpClient {
  /** 调用 /v1/me,失败返回 null(用于 apps/client 的 layout 守卫) */
  getMe(): Promise<MeInfo | null>;
}

export function createClientApiClient(options: ClientApiClientOptions): ClientApiClient {
  const http = createHttpClient(options);
  return {
    ...http,
    async getMe(): Promise<MeInfo | null> {
      try {
        return await http.get<MeInfo>('/v1/me');
      } catch {
        return null; // 布局守卫语义:任何失败(含未登录)都按无会话处理
      }
    },
  };
}
