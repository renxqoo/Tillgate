/**
 * admin-api(管理面)facade:core transport + 管理面 DTO 快照 + getAdminMe 布局守卫。
 *
 * 双后端物理隔离:
 *   - admin-api(管理面,端口 8082):/v1/providers、/v1/channels、/v1/models、
 *     /v1/users、/v1/plans、/v1/channel-funds、/v1/billing-operations、/v1/tracing 等
 * 会话 token 来源由装配方显式注入(不按基地址挑选 token 源)。
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
  AdminCreatedRow,
  AdminMeInfo,
  AdminPatchBody,
  AdminRow,
  PermissionNode,
  RoleRow,
} from './dto/admin-api.generated';

/** 接口绑定行（/v1/endpoint-bindings——DTO 生成物未命名,客户端内联声明） */
export interface EndpointBindingRow {
  id: number;
  method: string;
  path: string;
  permissionId: number;
  source: string;
  createdAt: string;
}

export interface AdminApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getToken?: TokenGetter;
  getHeaders?: HeaderGetter;
}

export interface AdminApiClient extends HttpClient {
  /**
   * 调用 /v1/me,失败返回 null(用于 apps/admin 的 layout 守卫)。
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
  listAdmins(params?: AdminListParams): Promise<Paginated<AdminRow>>;

  /** 创建管理员（POST /v1/admins;邀请制——资料行 + email 凭据 + 邀请邮件,响应含投递结果） */
  createAdmin(input: AdminCreateBody): Promise<AdminCreatedRow>;

  /** 重发邀请邮件（POST /v1/admins/:id/resend-invite;仅待激活管理员,60s 冷却） */
  resendAdminInvite(id: number): Promise<{ ok: true }>;

  /** 更新管理员（PATCH /v1/admins/:id;roleId/status 不可改自身） */
  updateAdmin(id: number, input: AdminPatchBody): Promise<AdminRow>;

  // ---- 动态 RBAC ----
  /** 角色列表（含授权码集与挂载管理员计数） */
  listRoles(
    params?: AdminListParams,
  ): Promise<Paginated<RoleRow & { adminCount: number; codes: string[] }>>;

  createRole(input: {
    code: string;
    name: string;
    description?: string | null;
    permissions: string[];
  }): Promise<RoleRow>;

  updateRole(
    id: number,
    input: {
      name?: string;
      description?: string | null;
      status?: number;
      permissions?: string[];
    },
  ): Promise<RoleRow>;

  deleteRole(id: number): Promise<{ ok: true }>;

  /** 权限树全量（平铺;管理面组树与绑定 UI 共用） */
  permissionTree(): Promise<PermissionNode[]>;

  createPermission(input: {
    parentId: number | null;
    type: 'group' | 'page' | 'button';
    code?: string | null;
    name: string;
    i18nKey?: string | null;
    description?: string | null;
    path?: string | null;
    icon?: string | null;
    sortOrder: number;
  }): Promise<PermissionNode>;

  updatePermission(
    id: number,
    input: Partial<
      Pick<
        PermissionNode,
        | 'name'
        | 'i18nKey'
        | 'description'
        | 'icon'
        | 'path'
        | 'sortOrder'
        | 'status'
        | 'code'
        | 'type'
        | 'parentId'
        | 'source'
      >
    >,
  ): Promise<PermissionNode>;

  deletePermission(id: number): Promise<{ ok: true }>;

  // ---- 接口绑定 ----
  listEndpointBindings(): Promise<EndpointBindingRow[]>;

  createEndpointBinding(input: {
    method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    permissionId: number;
  }): Promise<EndpointBindingRow>;

  /** 部分更新（method/path/permissionId 至少一项——契约层校验） */
  updateEndpointBinding(
    id: number,
    input: { method?: string; path?: string; permissionId?: number },
  ): Promise<EndpointBindingRow>;

  deleteEndpointBinding(id: number): Promise<{ ok: true }>;

  /** 本人菜单树（group+page 两级,按授权过滤——sidebar 数据源） */
  getMyMenus(): Promise<{ groups: MenuGroup[] }>;
}

/** /v1/me/menus 组节点 */
export interface MenuGroup {
  id: number;
  i18nKey: string | null;
  name: string;
  items: {
    id: number;
    i18nKey: string | null;
    name: string;
    path: string | null;
    icon: string | null;
    code: string | null;
  }[];
}

export interface AdminPasswordChangeResult {
  token: string;
}

/** 管理面统一列表查询参数(admins/roles 共用契约 ?page&page_size&q&sort_by&order) */
export interface AdminListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sortBy?: string;
  order?: 'asc' | 'desc';
}

/** 列表查询串构造:空缺字段不拼接;全空返回 ''(不带 ?) */
function adminListQuery(params?: AdminListParams): string {
  const query = new URLSearchParams();
  if (params?.page != null) query.set('page', String(params.page));
  if (params?.pageSize != null) query.set('page_size', String(params.pageSize));
  if (params?.q != null && params.q !== '') query.set('q', params.q);
  if (params?.sortBy != null) query.set('sort_by', params.sortBy);
  if (params?.order != null) query.set('order', params.order);
  return query.size > 0 ? `?${query.toString()}` : '';
}

// eslint-disable-next-line max-lines-per-function -- 管理面 facade:线性 CRUD 方法平铺(一端点一薄包装),拆分只会制造人工接缝
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
      return http.get<Paginated<AdminRow>>(`/v1/admins${adminListQuery(params)}`);
    },
    async createAdmin(input: AdminCreateBody) {
      return http.post<AdminCreatedRow>('/v1/admins', input);
    },
    async resendAdminInvite(id: number) {
      return http.post<{ ok: true }>(`/v1/admins/${id}/resend-invite`);
    },
    async updateAdmin(id: number, input: AdminPatchBody) {
      return http.patch<AdminRow>(`/v1/admins/${id}`, input);
    },
    async listRoles(params) {
      return http.get<Paginated<RoleRow & { adminCount: number; codes: string[] }>>(
        `/v1/roles${adminListQuery(params)}`,
      );
    },
    async createRole(input) {
      return http.post<RoleRow>('/v1/roles', input);
    },
    async updateRole(id, input) {
      return http.patch<RoleRow>(`/v1/roles/${id}`, input);
    },
    async deleteRole(id) {
      return http.delete<{ ok: true }>(`/v1/roles/${id}`);
    },
    async permissionTree() {
      const data = await http.get<{ rows: PermissionNode[] }>('/v1/permissions/tree');
      return data.rows ?? [];
    },
    async createPermission(input) {
      return http.post<PermissionNode>('/v1/permissions', input);
    },
    async updatePermission(id, input) {
      return http.patch<PermissionNode>(`/v1/permissions/${id}`, input);
    },
    async deletePermission(id) {
      return http.delete<{ ok: true }>(`/v1/permissions/${id}`);
    },
    async listEndpointBindings() {
      const data = await http.get<{ rows: EndpointBindingRow[] }>('/v1/endpoint-bindings');
      return data.rows ?? [];
    },
    async createEndpointBinding(input) {
      return http.post<EndpointBindingRow>('/v1/endpoint-bindings', input);
    },
    async updateEndpointBinding(id, input) {
      return http.patch<EndpointBindingRow>(`/v1/endpoint-bindings/${id}`, input);
    },
    async deleteEndpointBinding(id) {
      return http.delete<{ ok: true }>(`/v1/endpoint-bindings/${id}`);
    },
    async getMyMenus() {
      return http.get<{ groups: MenuGroup[] }>('/v1/me/menus');
    },
  };
}
