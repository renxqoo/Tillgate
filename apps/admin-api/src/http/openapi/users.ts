/**
 * 用户/资金/Key 域 OpenAPI registry（routes/{users,users-funds,keys}.ts 契约面）。
 * 请求 schema 引用 contracts/users.ts 与 contracts/auth.ts;响应 wire 形状在此声明
 * （形状与 presenters/users.ts、presenters/keys.ts 投影逐字段对齐——金额恒十进制字符串）。
 */
import * as z from 'zod';
import { debitFloorUpdateSchema, keysContracts, usersContracts } from '../contracts/users';
import { authContracts } from '../contracts/auth';
import { idPathParam, listQuery, paginatedOf, okTrue, type OpenApiEndpoint } from './shared';
import { auditLogRowSchema } from './observability';

/** 管理面用户行（GET /v1/users 列表行与详情同形;钱包富化三金额 + 信用/日限） */
export const adminUserRowSchema = z
  .object({
    id: z.number(),
    issuer: z.string().nullable(),
    subject: z.string(),
    identityProvider: z.string().nullable(),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    rateCardId: z.number().nullable(),
    rateCardName: z.string().nullable(),
    balance: z.string(),
    reservedBalance: z.string(),
    availableBalance: z.string(),
    creditLimit: z.string().describe('透支上限(元,>=0)。信用模型:balance 允许降到 -creditLimit。'),
    debitFloor: z
      .string()
      .describe('结算透支地板(元,>=0)。结算超收可负到 -(creditLimit+debitFloor);0 = 不透支。'),
    debitFloorSource: z
      .enum(['default', 'manual'])
      .describe('地板来源:default=随全局默认(批量刷默认会覆盖);manual=管理员手工(批量永不动)。'),
    dailySpendLimit: z.string().nullable().describe('每日花费上限(元,NULL=不限)。'),
    status: z.number(),
    isEnterprise: z.boolean(),
    freezeReason: z.string().nullable(),
    rpmLimit: z.number().nullable(),
    tpmLimit: z.number().nullable(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({
    id: 'AdminUserRow',
    description:
      '管理面用户行(GET /v1/users;钱包富化口径 available = balance + creditLimit − inFlight)',
  });

/** 管理面交易行（多操作管理员字段,终端用户不可见） */
export const adminTransactionRowSchema = z
  .object({
    id: z.number(),
    userId: z.number(),
    type: z.string().describe('交易类型(billing statement transactionKind)'),
    amount: z.string(),
    balanceAfter: z.string(),
    refType: z.string().nullable(),
    refId: z.string().nullable(),
    remark: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.number().nullable().describe('操作管理员(恒 null——无来源列)'),
  })
  .meta({
    id: 'AdminTransactionRow',
    description: '管理面交易行(GET /v1/users/:id/transactions;多操作管理员字段,终端用户不可见)',
  });

/** 管理面 Key 行（keyPreview 脱敏回显,明文永不回显） */
export const adminKeyRowSchema = z
  .object({
    id: z.number(),
    keyPreview: z.string().describe('脱敏预览 sk_****abcd(明文永不回显)'),
    name: z.string(),
    remark: z.string().nullable(),
    subscriptionId: z.number().nullable().describe('计费来源:NULL=余额;非空=扣该订阅额度。'),
    userId: z.number(),
    userEmail: z.string().nullable().describe('用户邮箱(accounts 行无用户 join,恒 null)'),
    userDisplayName: z.string().nullable().describe('用户展示名(accounts 行无用户 join,恒 null)'),
    rpmLimit: z.number().nullable(),
    tpmLimit: z.number().nullable(),
    dailySpendLimit: z.string().nullable().describe('Key 级每日花费上限(元,NULL=不限)。'),
    status: z.number(),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({
    id: 'AdminKeyRow',
    description: '管理面 API Key 行(GET /v1/admin-keys;keyPreview 脱敏回显)',
  });

/** 调账/赠送幂等回执（FundsReceipt wire 形状） */
const fundsReceiptSchema = z.object({
  ok: z.literal(true),
  balanceBefore: z.string().describe('操作前余额(元,numeric 字符串)'),
  balanceAfter: z.string().describe('操作后余额(元,numeric 字符串)'),
  replayed: z.boolean().describe('幂等键重放(同键同参)时 true'),
});

export const usersEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/users',
    tag: 'users',
    summary: '用户列表（钱包富化 + 企业/状态过滤）',
    query: listQuery(usersContracts.listQueryExtra),
    response: { schema: paginatedOf(adminUserRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/users/:id',
    tag: 'users',
    summary: '用户资料（含钱包富化与费率卡名）',
    params: [idPathParam('用户 id')],
    response: { schema: adminUserRowSchema },
    errors: [400, 401, 404],
  },
  {
    method: 'patch',
    path: '/v1/users/:id',
    tag: 'users',
    summary: '用户补丁（封禁语义:freezeReason 只能随 status=1 一并设置）',
    params: [idPathParam('用户 id')],
    body: usersContracts.patch,
    response: { schema: z.object({ id: z.number() }) },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/users/:id/set-password',
    tag: 'users',
    summary: '管理员为本地账号重置密码（绑默认卡「标准」+ 全网会话下线）',
    params: [idPathParam('用户 id')],
    body: authContracts.setPassword,
    response: { schema: okTrue },
    errors: [400, 401, 404],
  },
  {
    method: 'put',
    path: '/v1/users/:id/debit-floor',
    tag: 'users',
    summary: '设置用户透支地板（manual 来源;批量刷默认永不覆盖;后置审计）',
    params: [idPathParam('用户 id')],
    body: debitFloorUpdateSchema,
    response: {
      schema: z.object({ ok: okTrue, floorAfter: z.string(), source: z.enum(['manual']) }),
    },
    errors: [400, 401, 403, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/wallets/debit-floor/apply-default',
    tag: 'users',
    summary: '存量批量刷默认地板（仅 default 来源;manual 不动;贴线不足跳过计数;后置审计）',
    response: {
      schema: z.object({ applied: z.number(), skipped: z.number(), floor: z.string() }),
    },
    errors: [401, 403],
  },
  {
    method: 'post',
    path: '/v1/users/:id/adjust',
    tag: 'users',
    summary: '调账（可负;幂等键 + 同事务审计）',
    params: [idPathParam('用户 id')],
    body: usersContracts.adjust,
    response: { schema: fundsReceiptSchema },
    errors: [400, 401, 404, 409, 503],
  },
  {
    method: 'post',
    path: '/v1/users/:id/gift',
    tag: 'users',
    summary: '赠送（幂等键 + 同事务审计）',
    params: [idPathParam('用户 id')],
    body: usersContracts.gift,
    response: { schema: fundsReceiptSchema },
    errors: [400, 401, 404, 409, 503],
  },
  {
    method: 'get',
    path: '/v1/users/:id/transactions',
    tag: 'users',
    summary: '钱包流水（total = offset + rows.length——statement 无计数动词）',
    params: [idPathParam('用户 id')],
    query: listQuery(usersContracts.transactionsQuery),
    response: { schema: paginatedOf(adminTransactionRowSchema) },
    errors: [400, 401, 404],
  },
  {
    method: 'get',
    path: '/v1/users/:id/audit-logs',
    tag: 'users',
    summary: '用户维度审计列表（targetType=user;total = offset + rows.length）',
    params: [idPathParam('用户 id')],
    query: listQuery(),
    response: { schema: paginatedOf(auditLogRowSchema) },
    errors: [400, 401, 404],
  },
  {
    method: 'get',
    path: '/v1/admin-keys',
    tag: 'keys',
    summary: 'API Key 全量列表（userId/status 过滤）',
    query: listQuery(keysContracts.listQueryExtra),
    response: { schema: paginatedOf(adminKeyRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'patch',
    path: '/v1/admin-keys/:id',
    tag: 'keys',
    summary: 'Key 限额与状态补丁（status 枚举 0..1,非法 99 → 400）',
    params: [idPathParam('Key id')],
    body: keysContracts.patch,
    response: { schema: adminKeyRowSchema },
    errors: [400, 401, 404],
  },
];
