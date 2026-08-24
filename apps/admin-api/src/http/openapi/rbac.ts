/**
 * 动态 RBAC OpenAPI registry（routes/{roles,permissions}.ts 契约面——docs/admin-rbac-dynamic）。
 */
import { z } from 'zod';
import { rbacContracts } from '../contracts/rbac';
import { idPathParam, listQuery, paginatedOf, type OpenApiEndpoint } from './shared';

/** 角色行（含授权码集合与挂载管理员计数） */
export const roleRowSchema = z
  .object({
    id: z.number(),
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.number().describe('0 正常 / 1 停用（整角色 kill-switch）'),
    isSuper: z.boolean(),
    isBuiltin: z.boolean(),
    createdAt: z.string(),
  })
  .meta({ id: 'RoleRow', description: '角色资料行（/v1/roles）' });

/** 权限树节点（平铺;前端自组树） */
export const permissionNodeSchema = z
  .object({
    id: z.number(),
    parentId: z.number().nullable(),
    type: z.enum(['group', 'page', 'button']),
    code: z.string().nullable().describe('判定原语（group 无码;page 可无码=全员可见）'),
    name: z.string(),
    i18nKey: z.string().nullable(),
    description: z.string().nullable(),
    path: z.string().nullable().describe('page 专属:前端路由路径'),
    icon: z.string().nullable().describe('page 专属:lucide 图标名'),
    sortOrder: z.number(),
    status: z.number().describe('0 正常 / 1 停用（kill-switch;enforced 不可停用）'),
    source: z.enum(['enforced', 'custom']),
    createdAt: z.string(),
  })
  .meta({ id: 'PermissionNode', description: '权限树节点（/v1/permissions/tree）' });

export const rbacEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/roles',
    tag: 'roles',
    summary: '角色列表（统一列表契约;含授权码集与挂载管理员计数）',
    query: listQuery(),
    response: {
      schema: paginatedOf(
        roleRowSchema.extend({ adminCount: z.number(), codes: z.array(z.string()) }),
      ),
    },
    errors: [400],
  },
  {
    method: 'post',
    path: '/v1/roles',
    tag: 'roles',
    summary: '创建角色（code 唯一;授权码须全部为活动权限）',
    body: rbacContracts.createRole,
    response: { schema: roleRowSchema, status: 201 },
    errors: [400, 409],
  },
  {
    method: 'patch',
    path: '/v1/roles/:id',
    tag: 'roles',
    summary: '更新角色（授权全量替换 LWW;super 全锁;审计含 added/removed diff）',
    params: [idPathParam('角色 id')],
    body: rbacContracts.patchRole,
    response: { schema: roleRowSchema },
    errors: [400, 403, 404],
  },
  {
    method: 'delete',
    path: '/v1/roles/:id',
    tag: 'roles',
    summary: '删除角色（super/内置拒;有挂载管理员拒）',
    params: [idPathParam('角色 id')],
    response: { schema: z.object({ ok: z.literal(true) }) },
    errors: [403, 404, 409],
  },
  {
    method: 'get',
    path: '/v1/permissions/tree',
    tag: 'permissions',
    summary: '权限树全量（平铺节点;管理面组树与绑定 UI 共用）',
    response: { schema: z.object({ rows: z.array(permissionNodeSchema) }) },
  },
  {
    method: 'post',
    path: '/v1/permissions',
    tag: 'permissions',
    summary: '创建资源节点（恒 custom;码全局唯一;button 挂 page,page 挂 group）',
    body: rbacContracts.createPermission,
    response: { schema: permissionNodeSchema, status: 201 },
    errors: [400, 404, 409],
  },
  {
    method: 'patch',
    path: '/v1/permissions/:id',
    tag: 'permissions',
    summary: '更新资源节点（仅展示字段;enforced 停用拒;code/type/父子恒不可改）',
    params: [idPathParam('节点 id')],
    body: rbacContracts.patchPermission,
    response: { schema: permissionNodeSchema },
    errors: [400, 403, 404],
  },
  {
    method: 'get',
    path: '/v1/endpoint-bindings',
    tag: 'endpoints',
    summary: '接口绑定清单（全局 ACL 的执行面数据源）',
    response: {
      schema: z.object({
        rows: z.array(
          z.object({
            id: z.number(),
            method: z.string(),
            path: z.string(),
            permissionId: z.number(),
            source: z.enum(['enforced', 'custom']),
            createdAt: z.string(),
          }),
        ),
      }),
    },
  },
  {
    method: 'post',
    path: '/v1/endpoint-bindings',
    tag: 'endpoints',
    summary: '新建接口绑定（method+path 唯一;未绑定端点默认拒绝——fail-closed）',
    body: z.object({
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().min(2).max(255),
      permissionId: z.number().int().min(1),
    }),
    response: {
      schema: z.object({
        id: z.number(),
        method: z.string(),
        path: z.string(),
        permissionId: z.number(),
        source: z.string(),
        createdAt: z.string(),
      }),
      status: 201,
    },
    errors: [400, 404, 409],
  },
  {
    method: 'patch',
    path: '/v1/endpoint-bindings/:id',
    tag: 'endpoints',
    summary: '换绑（method+path 不变,改挂权限节点;下一请求生效）',
    params: [idPathParam('绑定 id')],
    body: z.object({ permissionId: z.number().int().min(1) }),
    response: {
      schema: z.object({
        id: z.number(),
        method: z.string(),
        path: z.string(),
        permissionId: z.number(),
        source: z.string(),
        createdAt: z.string(),
      }),
    },
    errors: [400, 404],
  },
  {
    method: 'delete',
    path: '/v1/endpoint-bindings/:id',
    tag: 'endpoints',
    summary: '解绑（该接口随后默认拒绝,直到重新绑定）',
    params: [idPathParam('绑定 id')],
    response: { schema: z.object({ ok: z.literal(true) }) },
    errors: [404],
  },
  {
    method: 'delete',
    path: '/v1/permissions/:id',
    tag: 'permissions',
    summary: '删除资源节点（enforced 拒;有子节点拒;被角色绑定拒）',
    params: [idPathParam('节点 id')],
    response: { schema: z.object({ ok: z.literal(true) }) },
    errors: [403, 404, 409],
  },
];
