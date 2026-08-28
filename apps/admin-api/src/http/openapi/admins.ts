/**
 * 管理员管理域 OpenAPI registry（routes/admins.ts 的契约面——RBAC admins 域,
 * super_admin 专属）。请求 schema 引用 contracts/admins.ts;响应 wire 形状在此声明。
 */
import * as z from 'zod';
import { adminsContracts } from '../contracts/admins';
import { idPathParam, listQuery, paginatedOf, type OpenApiEndpoint } from './shared';

/** 管理员资料行（列表/创建/更新共用投影——不含密码/2FA 密钥列;
 *  hasPassword = 激活态(邀请邮件是否还有意义——待激活标记/重发按钮显隐) */
export const adminRowSchema = z
  .object({
    id: z.number(),
    email: z.string(),
    displayName: z.string().nullable(),
    roleId: z.number().describe('角色 FK（roles.id）'),
    role: z.string().describe('角色 code（展示用;名称经 /v1/roles 解析）'),
    status: z.number().describe('0 正常 / 1 封禁 / 2 注销'),
    twoFactorEnabled: z.boolean(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
    hasPassword: z.boolean().describe('是否已设置密码(false = 待激活,邀请邮件可发/可重发)'),
  })
  .meta({
    id: 'AdminRow',
    description: '管理员资料行（GET/POST /v1/admins,PATCH /v1/admins/:id）',
  });

/** 创建响应 = 资料行 + 邀请邮件投递结果（失败不回滚——列表重发补救） */
export const adminCreatedSchema = adminRowSchema
  .extend({
    inviteSent: z.boolean().describe('邀请邮件是否已投递（SMTP/地址未配置或投递失败 = false）'),
  })
  .meta({
    id: 'AdminCreated',
    description: '创建管理员响应（资料行 + 邀请邮件投递结果）',
  });

export const adminsEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/admins',
    tag: 'admins',
    summary: '管理员列表（统一列表契约 ?page&page_size&q&sort_by;admins 域——仅 super_admin）',
    query: listQuery(),
    response: {
      schema: paginatedOf(adminRowSchema),
    },
    errors: [400, 403],
  },
  {
    method: 'post',
    path: '/v1/admins',
    tag: 'admins',
    summary: '创建管理员（邀请制:资料行 + email 凭据 + 邀请邮件;凭据被占即补偿回滚）',
    body: adminsContracts.create,
    response: { schema: adminCreatedSchema, status: 201 },
    errors: [400, 403, 409],
  },
  {
    method: 'post',
    path: '/v1/admins/:id/resend-invite',
    tag: 'admins',
    summary: '重发邀请邮件（仅待激活管理员;60s 冷却;SMTP/地址未配置 503）',
    params: [idPathParam('管理员 id')],
    response: { schema: z.object({ ok: z.literal(true) }) },
    errors: [400, 403, 404, 409, 429, 503],
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
