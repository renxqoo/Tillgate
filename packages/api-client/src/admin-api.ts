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
import type { Paginated } from './core/pagination';
import type {
  AdminCreateBody,
  AdminMeInfo,
  AdminPatchBody,
  AdminRow,
} from './dto/admin-api.generated';

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

  /**
   * 修改自己的管理员密码(POST /v1/me/password,session 鉴权 + 验旧密)。
   * 成功即推进 admin realm 失效线——**旧会话全部失效**,响应携带新签 token,
   * 调用方(BFF)必须立即用返回值换会话 cookie,否则用户当场被登出。
   */
  changeMyPassword(input: {
    oldPassword: string;
    newPassword: string;
  }): Promise<AdminPasswordChangeResult>;

  /** 管理员列表（GET /v1/admins;统一列表契约 ?page&page_size&q&sort_by;admins 域——仅 super_admin） */
  listAdmins(params?: {
    page?: number;
    pageSize?: number;
    q?: string;
    sortBy?: string;
    order?: 'asc' | 'desc';
  }): Promise<Paginated<AdminRow>>;

  /** 创建管理员（POST /v1/admins;资料行 + identity 凭据双动词编排） */
  createAdmin(input: AdminCreateBody): Promise<AdminRow>;

  /** 更新管理员（PATCH /v1/admins/:id;role/status 不可改自身） */
  updateAdmin(id: number, input: AdminPatchBody): Promise<AdminRow>;
}

export interface AdminPasswordChangeResult {
  token: string;
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
    async changeMyPassword(input: { oldPassword: string; newPassword: string }) {
      return http.post<AdminPasswordChangeResult>('/v1/me/password', input);
    },
    async listAdmins(params) {
      const query = new URLSearchParams();
      if (params?.page != null) query.set('page', String(params.page));
      if (params?.pageSize != null) query.set('page_size', String(params.pageSize));
      if (params?.q != null && params.q !== '') query.set('q', params.q);
      if (params?.sortBy != null) query.set('sort_by', params.sortBy);
      if (params?.order != null) query.set('order', params.order);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return http.get<Paginated<AdminRow>>(`/v1/admins${suffix}`);
    },
    async createAdmin(input: AdminCreateBody) {
      return http.post<AdminRow>('/v1/admins', input);
    },
    async updateAdmin(id: number, input: AdminPatchBody) {
      return http.patch<AdminRow>(`/v1/admins/${id}`, input);
    },
  };
}
