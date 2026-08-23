/**
 * 营销/邀请域 OpenAPI registry（routes/{marketing,referrals}.ts 契约面）。
 * 请求 schema 引用 contracts/marketing.ts;响应 wire 形状按 accounts/billing 返回面。
 */
import { z } from 'zod';
import { marketingContracts, referralContracts, REFERRAL_KINDS } from '../contracts/marketing';
import { idPathParam, listQuery, paginatedOf, type OpenApiEndpoint } from './shared';

/** 营销配置（拉新资金参数;改值即时生效、历史不重算） */
const marketingSettingsSchema = z.object({
  signupGiftAmount: z.string(),
  referralSignupBonus: z.string(),
  referralCommissionRate: z.string(),
  updatedBy: z.number().nullable().describe('最后修改管理员（null=初始值）'),
  updatedAt: z.string(),
});

/** 邀请关系行（双方邮箱/状态;v2 去 wallet 化——资金投影走 payouts 端点） */
const referralRelationRowSchema = z.object({
  id: z.number(),
  inviterUserId: z.number(),
  inviterEmail: z.string().nullable(),
  inviterDisplayName: z.string().nullable(),
  inviteeUserId: z.number(),
  inviteeEmail: z.string().nullable(),
  inviteeDisplayName: z.string().nullable(),
  status: z.number().describe('0=正常派奖 1=封禁停发（历史入账不动）'),
  createdAt: z.string(),
});

/** 返利流水行（佣金/邀请注册奖励/注册赠送——wallet 流水投影） */
const referralPayoutRowSchema = z.object({
  id: z.number(),
  kind: z.string().describe(`返利分类（${REFERRAL_KINDS.join('/')}）`),
  refType: z.string(),
  refId: z.string(),
  memo: z.string().nullable(),
  createdAt: z.string(),
});

export const marketingEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/marketing/settings',
    tag: 'marketing',
    summary: '营销配置读取（worker 佣金循环每 tick 读现值同源）',
    response: { schema: marketingSettingsSchema },
    errors: [401],
  },
  {
    method: 'put',
    path: '/v1/marketing/settings',
    tag: 'marketing',
    summary: '营销配置更新（管理面唯一修改入口;审计在 accounts 用例内）',
    body: marketingContracts.updateSettings,
    response: { schema: marketingSettingsSchema },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/referrals/relations',
    tag: 'referrals',
    summary: '邀请关系列表（双方邮箱/状态）',
    query: listQuery(),
    response: { schema: paginatedOf(referralRelationRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'patch',
    path: '/v1/referrals/relations/:id',
    tag: 'referrals',
    summary: '关系封禁/恢复（0 停发 1 恢复;封禁后 worker 停止派奖,历史入账不动）',
    params: [idPathParam('关系 id')],
    body: referralContracts.patchRelation,
    response: { schema: referralRelationRowSchema },
    errors: [400, 401, 404],
  },
  {
    method: 'get',
    path: '/v1/referrals/payouts',
    tag: 'referrals',
    summary: '返利流水（kind 必填;佣金/邀请注册奖励/注册赠送）',
    query: listQuery(
      z.object({
        kind: z.enum(REFERRAL_KINDS).describe('返利分类（词表外 → 400）'),
      }),
    ),
    response: { schema: paginatedOf(referralPayoutRowSchema) },
    errors: [400, 401],
  },
];
