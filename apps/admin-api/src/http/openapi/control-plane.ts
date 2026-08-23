/**
 * 控制面域 OpenAPI registry（routes/{providers,channels,channel-funds,vouchers}.ts 契约面）。
 * 请求 schema 引用 contracts/control-plane.ts;响应 wire 形状在此声明
 * （与 presenters/control-plane.ts 投影逐字段对齐——金额恒十进制字符串）。
 */
import { z } from 'zod';
import {
  channelFundsContracts,
  channelsContracts,
  providersContracts,
} from '../contracts/control-plane';
import { idPathParam, listQuery, paginatedOf, okTrue, type OpenApiEndpoint } from './shared';

/** 管理面渠道行（v2 wire 偏差:cooldownUntil/providerBaseUrl/updatedAt 无列来源恒 null） */
export const adminChannelRowSchema = z
  .object({
    id: z.number(),
    providerId: z.number(),
    name: z.string(),
    baseUrlOverride: z.string().nullable(),
    models: z
      .string()
      .nullable()
      .describe(
        '模型白名单(DB jsonb 数组;DTO 面沿 v1 快照口径 string | null——数组线上形态在 admin 表单边界转换)',
      ),
    weight: z.number(),
    priority: z.number(),
    status: z.number(),
    failCount: z.number(),
    deletedAt: z.string().nullable().describe('记录面逻辑删除时刻(回收站);null = 在册'),
    cooldownUntil: z.string().nullable().describe('冷却截止(v2 无列来源,恒 null)'),
    rpmLimit: z.number().nullable(),
    tpmLimit: z.number().nullable(),
    upstreamBudget: z.string().describe('进货总额(元,numeric 字符串)'),
    upstreamThreshold: z.string().nullable().describe('熔断阈值(元,string | null)'),
    upstreamConsumed: z.string().describe('已消耗上游成本(元,string)'),
    upstreamRemaining: z.string().describe('剩余 = 进货 - 已消耗(元,string)'),
    createdAt: z.string(),
    updatedAt: z.string().describe('更新时间(v2 无列来源,恒 null)'),
    providerName: z.string(),
    providerBaseUrl: z.string().describe('供应商 baseUrl(v2 无列来源,恒 null)'),
    boundModels: z
      .array(z.object({ externalName: z.string(), realModel: z.string() }))
      .describe('已绑定模型清单(绑定名投影)'),
  })
  .meta({
    id: 'AdminChannelRow',
    description: '管理面渠道行(GET /v1/channels;渠道资金四金额 + 绑定模型清单)',
  });

/** 渠道连通性探针结果（上游失败也是探针结果,不是管理面错误） */
export const channelTestResultSchema = z
  .object({
    ok: z.boolean(),
    durationMs: z.number(),
    error: z
      .union([
        z.string(),
        z.object({ code: z.string().optional(), message: z.string().optional() }),
      ])
      .optional()
      .describe('后端返回 string 或 { code, message }'),
    keyPreview: z.string().optional(),
  })
  .meta({
    id: 'ChannelTestResult',
    description: '渠道连通性探针结果(POST /v1/channels/:id/test;模型探针 /v1/models/:id/test 同形)',
  });

/** 管理面供应商行 */
export const adminProviderRowSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    baseUrl: z.string(),
    protocol: z.string(),
    vendor: z
      .string()
      .nullable()
      .describe('厂商档案引用(VENDOR_PROFILES 词表键;null = 无档案纯透传)'),
    status: z.number(),
    deletedAt: z.string().nullable().describe('记录面逻辑删除时刻(回收站);null = 在册'),
    createdAt: z.string(),
    updatedAt: z
      .string()
      .optional()
      .describe(
        'providers 表当前无 updated_at 列,接口实际不返回该字段(undefined)。前端展示需做空值兜底(回退 createdAt)。',
      ),
  })
  .meta({ id: 'AdminProviderRow', description: '管理面供应商行(GET /v1/providers)' });

/** 渠道资金流水行（进货/调账） */
export const adminChannelFundRowSchema = z
  .object({
    id: z.number(),
    channelId: z.number(),
    channelName: z.string(),
    type: z.enum(['recharge', 'adjust']).describe('recharge(入货)/ adjust(调账)'),
    amount: z.string().describe('有符号金额(元,numeric 字符串)'),
    balanceAfter: z.string().describe('变动后渠道额度余额快照(元)'),
    orderNo: z.string().nullable().describe('支付订单号'),
    voucher: z.string().nullable().describe('支付凭证 key(本地磁盘 / 未来 OSS)'),
    remark: z.string().nullable(),
    adminId: z.number().nullable(),
    adminEmail: z.string().nullable(),
    adminDisplayName: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'AdminChannelFundRow', description: '渠道资金流水行(GET /v1/channel-funds)' });

/** 供应商下拉选项（渠道表单用;页面从 AdminProviderRow 投影的 client-safe 选项,无独立端点） */
export const providerOptionSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    baseUrl: z.string(),
    protocol: z.string(),
    status: z.number(),
  })
  .meta({
    id: 'ProviderOption',
    description: '供应商下拉选项(渠道表单用,来源 AdminProviderRow)。',
  });

/** 渠道下拉选项（统一形状;无独立端点） */
export const channelOptionSchema = z
  .object({ id: z.number(), name: z.string(), providerName: z.string().optional() })
  .meta({
    id: 'ChannelOption',
    description:
      '渠道下拉选项(统一形状:models 绑定弹窗展示 providerName,channel-funds 仅用 id/name)。',
  });

/** 创建渠道回执（control-plane CreatedChannel——创建返回窄面,非列表行全形） */
const createdChannelSchema = z.object({
  id: z.number(),
  name: z.string(),
  providerId: z.number(),
});

/** 更新渠道回执（换 Key 复位运行态后的窄面） */
const updatedChannelSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.number(),
  failCount: z.number(),
});

/** 批量导入回执（best-effort;success=0 时 400） */
const importChannelsResultSchema = z.object({
  total: z.number(),
  success: z.number(),
  failed: z.number(),
  details: z.array(
    z.object({
      channelId: z.number().optional(),
      name: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** 进货/调账回执（numeric(38,18) 存储精度出站点归一——v1 wire 口径） */
const channelFundsReceiptSchema = z.object({
  ok: z.literal(true),
  rechargeId: z.number().describe('资金流水 id'),
  balanceAfter: z.string().describe('变动后渠道额度余额(元,出站点归一)'),
  replayed: z.boolean().describe('幂等键重放(同键同参)时 true'),
});

export const controlPlaneEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/providers',
    tag: 'providers',
    summary: '供应商列表（view=deleted = 回收站）',
    query: listQuery(z.object({ view: z.enum(['active', 'deleted']).optional() })),
    response: { schema: paginatedOf(adminProviderRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/providers',
    tag: 'providers',
    summary: '创建供应商',
    body: providersContracts.create,
    response: { schema: adminProviderRowSchema, status: 201 },
    errors: [400, 401, 409],
  },
  {
    method: 'patch',
    path: '/v1/providers/:id',
    tag: 'providers',
    summary: '更新供应商',
    params: [idPathParam('供应商 id')],
    body: providersContracts.update,
    response: { schema: adminProviderRowSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'delete',
    path: '/v1/providers/:id',
    tag: 'providers',
    summary:
      '删除供应商（逻辑删除/回收站：行与渠道引用保留，名称释放可复用；禁用走 PATCH status=1）',
    params: [idPathParam('供应商 id')],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/providers/:id/restore',
    tag: 'providers',
    summary: '恢复已删除的供应商（回收站取出，回禁用态不直接启用；在册行调用 → 404）',
    params: [idPathParam('供应商 id')],
    response: { schema: okTrue },
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/v1/channels',
    tag: 'channels',
    summary: '渠道列表（富化投影；view=deleted = 回收站）',
    query: listQuery(z.object({ view: z.enum(['active', 'deleted']).optional() })),
    response: { schema: paginatedOf(adminChannelRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/channels',
    tag: 'channels',
    summary: '创建渠道（apiKey 加密落库）',
    body: channelsContracts.create,
    response: { schema: createdChannelSchema, status: 201 },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'patch',
    path: '/v1/channels/:id',
    tag: 'channels',
    summary: '更新渠道（换 Key 复位运行态）',
    params: [idPathParam('渠道 id')],
    body: channelsContracts.update,
    response: { schema: updatedChannelSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'delete',
    path: '/v1/channels/:id',
    tag: 'channels',
    summary:
      '删除渠道（逻辑删除/回收站：绑定/流水保留，名称释放可复用；在册映射绑定中 → 409；停用走 PATCH status=1）',
    params: [idPathParam('渠道 id')],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/channels/:id/restore',
    tag: 'channels',
    summary: '恢复已删除的渠道（回收站取出，回停用态不直接启用；在册行调用 → 404）',
    params: [idPathParam('渠道 id')],
    response: { schema: okTrue },
    errors: [401, 404],
  },
  {
    method: 'post',
    path: '/v1/channels/import',
    tag: 'channels',
    summary: '渠道批量导入（best-effort;success=0 → 400）',
    body: channelsContracts.import,
    response: { schema: importChannelsResultSchema },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/channels/:id/test',
    tag: 'channels',
    summary: '渠道连通性探针',
    params: [idPathParam('渠道 id')],
    response: { schema: channelTestResultSchema },
    errors: [401, 404, 502, 504],
  },
  {
    method: 'get',
    path: '/v1/channel-funds',
    tag: 'channel-funds',
    summary: '渠道资金流水（channelId/type 过滤）',
    query: listQuery(channelFundsContracts.listQueryExtra),
    response: { schema: paginatedOf(adminChannelFundRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/channel-funds/recharge',
    tag: 'channel-funds',
    summary: '渠道进货（凭证 data URL 内联;幂等键透传）',
    body: channelFundsContracts.recharge,
    response: { schema: channelFundsReceiptSchema },
    errors: [400, 401, 404, 409, 413, 503],
  },
  {
    method: 'post',
    path: '/v1/channel-funds/adjust',
    tag: 'channel-funds',
    summary: '渠道调账（可负;幂等键透传）',
    body: channelFundsContracts.adjust,
    response: { schema: channelFundsReceiptSchema },
    errors: [400, 401, 404, 409, 503],
  },
  {
    method: 'get',
    path: '/v1/vouchers/:key',
    tag: 'channel-funds',
    summary: '进货凭证回读（原始字节流,content-type 原样回放——非 JSON）',
    params: [
      {
        name: 'key',
        description: '凭证存储键（键校验在 storage 侧,防路径穿越）',
        schema: z.string().min(1).max(255),
      },
    ],
    response: {
      schema: z.unknown(),
      description: '原始凭证字节流（content-type 原样回放,非 JSON 信封）',
    },
    errors: [401, 404],
  },
];
