/**
 * billing 管理域 OpenAPI registry（routes/{plans,redeem,subscriptions,billing-operations,
 * ops-orders}.ts 契约面）。请求 schema 引用 contracts/{billing-admin,subscriptions}.ts;
 * 响应 wire 形状在此声明（与 presenters/billing.ts 投影逐字段对齐——金额恒十进制字符串）。
 */
import { z } from 'zod';
import { plansContracts, redeemContracts, reviewContracts } from '../contracts/billing-admin';
import { subscriptionsContracts } from '../contracts/subscriptions';
import {
  idPathParam,
  listQuery,
  paginatedOf,
  okTrue,
  requestIdPathParam,
  type OpenApiEndpoint,
} from './shared';

/** 套餐行（plans 表行） */
export const planRowSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    kind: z.enum(['subscription', 'pack']),
    sortOrder: z.number().nullable(),
    price: z.string(),
    periodDays: z.number().describe('包月套餐 1~3650;加油包 0'),
    quotaAmount: z.string(),
    allowSeats: z.boolean(),
    status: z.number(),
  })
  .meta({ id: 'PlanRow', description: 'plans 表行(amount 均为元 numeric 字符串)。' });

/** 管理面兑换批次行 */
export const adminBatchRowSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    remark: z.string().nullable(),
    amount: z.string(),
    total: z.number(),
    usedCount: z.number(),
    createdBy: z.string().describe('创建管理员 id 的字符串投影(v1 wire 形状)'),
    createdAt: z.string(),
  })
  .meta({ id: 'AdminBatchRow', description: '管理面兑换批次行(GET /v1/redeem-batches)' });

/** 批次创建回执（明文码仅此一次返回） */
export const batchCreatedSchema = z
  .object({
    batch: z.object({ id: z.number(), name: z.string(), amount: z.string(), total: z.number() }),
    codes: z.array(z.string()).describe('明文兑换码(仅创建响应返回一次,库内只有哈希)'),
  })
  .meta({ id: 'BatchCreated', description: '批次创建回执(POST /v1/redeem-batches;明文码仅此一次返回)' });

/** 兑换码行（哈希脱敏——明文不可再现） */
export const redeemCodeRowSchema = z
  .object({
    id: z.number(),
    codeMasked: z.string().describe('哈希脱敏:首 8 + **** + 尾 4'),
    status: z.number(),
    usedBy: z.string().nullable().describe('使用用户 id 的字符串投影;null=未使用'),
    usedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .meta({ id: 'RedeemCodeRow', description: '兑换码行(GET /v1/redeem-batches/:id/codes;codeMasked 哈希脱敏)' });

/** 管理面订阅列表行 */
export const adminSubscriptionRowSchema = z
  .object({
    id: z.number(),
    userId: z.number(),
    userSubject: z.string(),
    userDisplayName: z.string().nullable(),
    planId: z.number(),
    planName: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    quotaAmount: z.string(),
    usedAmount: z.string(),
    reservedAmount: z.string(),
    quantity: z.number(),
    price: z.string(),
    remainingAmount: z.string(),
    status: z.number(),
    createdAt: z.string(),
  })
  .meta({ id: 'AdminSubscriptionRow', description: 'admin 订阅列表行。' });

/** 死单行（status=dead 专属列表;reservedAmount 仅非 null 时输出） */
export const deadCaseRowSchema = z
  .object({
    requestId: z.string(),
    userId: z.number(),
    status: z.string(),
    revision: z.number().describe('乐观锁修订号(retry/abandon 决策体须回传 expectedRevision)'),
    attempt: z.number(),
    failureCode: z.string().nullable(),
    lastError: z.string().nullable(),
    reservedAmount: z.string().optional().describe('冻结金额(元,numeric 字符串;可缺省)'),
    createdAt: z.string(),
  })
  .meta({ id: 'DeadCaseRow', description: '死单行(status=dead 专属列表;reservedAmount 仅非 null 时输出)。' });

/** 订阅续约/变更回执（billing SubscribeResult wire 形状） */
const subscribeResultSchema = z.object({
  userId: z.number(),
  subscriptionId: z.number(),
  orgId: z.number().nullable(),
  planId: z.number(),
  planName: z.string(),
  quantity: z.number(),
  startAt: z.string(),
  endAt: z.string(),
  quotaAmount: z.string(),
  price: z.string(),
  balanceBefore: z.string().nullable(),
  balanceAfter: z.string().nullable(),
  replayed: z.boolean(),
});

/** 加油包发放回执（grantPack） */
const grantPackResultSchema = z.object({
  userId: z.number(),
  subscriptionId: z.number(),
  quotaAdded: z.string(),
  balanceBefore: z.string(),
  balanceAfter: z.string(),
  replayed: z.boolean(),
});

/** 死单 retry 回执 */
const retryDeadResultSchema = z.object({
  requestId: z.string(),
  userId: z.number(),
  status: z.string(),
  revision: z.number(),
  replayed: z.boolean(),
});

/** 死单 abandon 回执 */
const abandonDeadResultSchema = z.object({
  requestId: z.string(),
  released: z.boolean(),
  replayed: z.boolean(),
});

/** 支付订单行（AdminPaymentOrderRow;时间 ISO 字符串） */
const adminPaymentOrderRowSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerOrderId: z.string(),
  userId: z.number(),
  userDisplayName: z.string().nullable(),
  userSubject: z.string().nullable(),
  amount: z.string(),
  creditAmount: z.string(),
  currency: z.string(),
  status: z.number(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  creditedAt: z.string().nullable(),
});

export const billingAdminEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/plans',
    tag: 'plans',
    summary: '套餐列表',
    query: listQuery(),
    response: { schema: paginatedOf(planRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/plans',
    tag: 'plans',
    summary: '创建套餐（kind 不可变——strictObject 拒未知键）',
    body: plansContracts.create,
    response: { schema: planRowSchema, status: 201 },
    errors: [400, 401, 409],
  },
  {
    method: 'patch',
    path: '/v1/plans/:id',
    tag: 'plans',
    summary: '更新套餐（kind 创建后不可变）',
    params: [idPathParam('套餐 id')],
    body: plansContracts.update,
    response: { schema: planRowSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'delete',
    path: '/v1/plans/:id',
    tag: 'plans',
    summary: '删除套餐（历史订阅引用守卫 409）',
    params: [idPathParam('套餐 id')],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/redeem-batches',
    tag: 'redeem',
    summary: '创建兑换批次（明文码仅此一次返回）',
    body: redeemContracts.create,
    response: { schema: batchCreatedSchema, status: 201 },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/redeem-batches',
    tag: 'redeem',
    summary: '兑换批次列表',
    query: listQuery(),
    response: { schema: paginatedOf(adminBatchRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/redeem-batches/:id',
    tag: 'redeem',
    summary: '批次详情',
    params: [idPathParam('批次 id')],
    response: { schema: adminBatchRowSchema },
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/v1/redeem-batches/:id/codes',
    tag: 'redeem',
    summary: '批内码列表（哈希脱敏;status 过滤）',
    params: [idPathParam('批次 id')],
    query: listQuery(redeemContracts.codesQueryExtra),
    response: { schema: paginatedOf(redeemCodeRowSchema) },
    errors: [400, 401, 404],
  },
  {
    method: 'post',
    path: '/v1/redeem-batches/codes/:codeId/revoke',
    tag: 'redeem',
    summary: '单码作废',
    params: [{ ...idPathParam('兑换码 id'), name: 'codeId' }],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
  {
    method: 'get',
    path: '/v1/subscriptions',
    tag: 'subscriptions',
    summary: '管理面订阅列表（planId/userId/status 过滤——数值容错解析,非整数忽略）',
    query: listQuery(
      z.object({
        planId: z.coerce.number().int().positive().optional(),
        userId: z.coerce.number().int().positive().optional(),
        status: z.coerce.number().int().optional(),
      }),
    ),
    response: { schema: paginatedOf(adminSubscriptionRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/subscriptions/:id/renew',
    tag: 'subscriptions',
    summary: '订阅续约（管理面 userId:null 直续免属主检查）',
    params: [idPathParam('订阅 id')],
    response: { schema: subscribeResultSchema },
    errors: [401, 404, 409, 503],
  },
  {
    method: 'post',
    path: '/v1/subscriptions/:id/change',
    tag: 'subscriptions',
    summary: '订阅变更（换目标套餐/坐席数）',
    params: [idPathParam('订阅 id')],
    body: subscriptionsContracts.change,
    response: { schema: subscribeResultSchema },
    errors: [400, 401, 404, 409, 503],
  },
  {
    method: 'post',
    path: '/v1/subscriptions/:id/cancel',
    tag: 'subscriptions',
    summary: '订阅取消',
    params: [idPathParam('订阅 id')],
    response: { schema: z.object({ subscriptionId: z.number(), replayed: z.boolean() }) },
    errors: [401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/subscriptions/:id/grant',
    tag: 'subscriptions',
    summary: '加油包发放（:id 为 pack id,body.userId 为受益用户）',
    params: [idPathParam('加油包(id 为 plan 的 pack 形态)')],
    body: subscriptionsContracts.grant,
    response: { schema: grantPackResultSchema },
    errors: [400, 401, 404, 409, 503],
  },
  {
    method: 'get',
    path: '/v1/billing-operations',
    tag: 'billing-operations',
    summary: '死单列表（status=dead 专属;其余状态走正常结算管线）',
    query: listQuery(),
    response: { schema: paginatedOf(deadCaseRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/billing-operations/:requestId/retry',
    tag: 'billing-operations',
    summary: '死单复核重试（乐观锁 expectedRevision;幂等键透传）',
    params: [requestIdPathParam],
    body: reviewContracts.decision,
    response: { schema: retryDeadResultSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/billing-operations/:requestId/abandon',
    tag: 'billing-operations',
    summary: '死单复核放弃（释放冻结;理由必填）',
    params: [requestIdPathParam],
    body: reviewContracts.decision,
    response: { schema: abandonDeadResultSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'get',
    path: '/v1/payment-orders',
    tag: 'payment-orders',
    summary: '支付订单管理列表',
    query: listQuery(),
    response: { schema: paginatedOf(adminPaymentOrderRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/payment-orders/:id/close',
    tag: 'payment-orders',
    summary: '手动关单（无请求体;关单理由装配注入;已付/已入账/已关 → 409）',
    params: [{ name: 'id', description: '订单 id（uuid 形状）', schema: z.string().min(16).max(64) }],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
];
