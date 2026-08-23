/**
 * 管理员管理域 OpenAPI registry（routes/admins.ts 的契约面——RBAC admins 域,
 * super_admin 专属）。请求 schema 引用 contracts/admins.ts;响应 wire 形状在此声明。
 */
import { z } from 'zod';
import { adminsContracts } from '../contracts/admins';
import { idPathParam, type OpenApiEndpoint } from './shared';

/** 管理员资料行（列表/创建/更新共用投影——不含密码/2FA 密钥列） */
export const adminRowSchema = z
  .object({
    id: z.number(),
    email: z.string(),
    displayName: z.string().nullable(),
    role: z
      .enum(['super_admin', 'operator', 'finance', 'support', 'viewer'])
      .describe('RBAC 角色（词表/矩阵单一真相 = control-plane domain/rbac）'),
    status: z.number().describe('0 正常 / 1 封禁 / 2 注销'),
    twoFactorEnabled: z.boolean(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({
    id: 'AdminRow',
    description: '管理员资料行（GET/POST /v1/admins,PATCH /v1/admins/:id）',
  });

export const adminsEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/admins',
    tag: 'admins',
    summary: '管理员列表（admins 域——仅 super_admin）',
    response: {
      schema: z.object({ rows: z.array(adminRowSchema) }),
    },
    errors: [403],
  },
  {
    method: 'post',
    path: '/v1/admins',
    tag: 'admins',
    summary: '创建管理员（资料行 + identity 凭据双动词,凭据被占即补偿回滚）',
    body: adminsContracts.create,
    response: { schema: adminRowSchema, status: 201 },
    errors: [400, 403, 409],
  },
  {
    method: 'patch',
    path: '/v1/admins/:id',
    tag: 'admins',
    summary: '更新管理员（role/status 不可改自身——防最后一个超管自锁）',
    params: [idPathParam('管理员 id')],
    body: adminsContracts.patch,
    response: { schema: adminRowSchema },
    errors: [400, 403, 404],
  },
];
