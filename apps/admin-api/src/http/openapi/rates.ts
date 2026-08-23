/**
 * 费率卡/汇率域 OpenAPI registry（routes/{rate-cards,fx}.ts 契约面）。
 * 请求 schema 引用 contracts/rates.ts;响应 wire 形状在此声明。
 */
import { z } from 'zod';
import { rateCardsContracts, fxCatalogContracts } from '../contracts/rates';
import { idPathParam, listQuery, paginatedOf, okTrue, type OpenApiEndpoint } from './shared';
import { fxStateSchema } from './catalog';

/** 管理面费率卡行（updatedAt 无列来源恒 null——MIGRATION §4 D12 族） */
export const adminRateCardRowSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.number(),
    createdAt: z.string(),
    updatedAt: z.string().nullable().describe('更新时间(v2 无列来源,恒 null)'),
    coefficient: z.string().describe('系数 numeric(6,3):0.001..9.999,回显恒 3 位小数'),
  })
  .meta({ id: 'AdminRateCardRow', description: '管理面费率卡行(GET /v1/rate-cards)' });

/** 费率卡下拉选项（用户绑定费率卡用;无独立端点） */
export const rateCardOptionSchema = z
  .object({ id: z.number(), name: z.string(), coefficient: z.string() })
  .meta({ id: 'RateCardOption', description: '费率卡下拉选项(用户绑定费率卡用,来源 AdminRateCardRow)。' });

/** 创建/更新回执（RateCardRecord——无 coefficient/updatedAt 列） */
const rateCardRecordSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.number(),
  createdAt: z.string(),
});

/** 卡内用户行（RateCardUserRow） */
const rateCardUserRowSchema = z.object({
  id: z.number(),
  subject: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
});

/** 健康自检（全局兜底系数存在性） */
const rateCardHealthSchema = z.object({
  hasGlobalCoefficient: z.boolean().describe('「每卡恰一全局行」约束的兜底行是否存在'),
  coefficient: z.string().nullable(),
});

export const rateCardsEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/rate-cards',
    tag: 'rate-cards',
    summary: '费率卡列表',
    query: listQuery(),
    response: { schema: paginatedOf(adminRateCardRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/rate-cards',
    tag: 'rate-cards',
    summary: '创建费率卡（系数 0.001..9.999）',
    body: rateCardsContracts.create,
    response: { schema: rateCardRecordSchema, status: 201 },
    errors: [400, 401, 409],
  },
  {
    method: 'patch',
    path: '/v1/rate-cards/:id',
    tag: 'rate-cards',
    summary: '更新费率卡',
    params: [idPathParam('费率卡 id')],
    body: rateCardsContracts.update,
    response: { schema: rateCardRecordSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'delete',
    path: '/v1/rate-cards/:id',
    tag: 'rate-cards',
    summary: '删除费率卡（绑定守卫 409）',
    params: [idPathParam('费率卡 id')],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
  {
    method: 'get',
    path: '/v1/rate-cards/:id/users',
    tag: 'rate-cards',
    summary: '卡内用户列表',
    params: [idPathParam('费率卡 id')],
    query: listQuery(),
    response: { schema: paginatedOf(rateCardUserRowSchema) },
    errors: [400, 401, 404],
  },
  {
    method: 'get',
    path: '/v1/rate-cards/:id/health',
    tag: 'rate-cards',
    summary: '费率卡健康自检（全局兜底系数存在性）',
    params: [idPathParam('费率卡 id')],
    response: { schema: rateCardHealthSchema },
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/v1/fx/catalog',
    tag: 'fx',
    summary: '汇率状态（含懒拉快照）',
    response: { schema: fxStateSchema },
    errors: [401, 503],
  },
  {
    method: 'post',
    path: '/v1/fx/catalog/refresh',
    tag: 'fx',
    summary: '强制刷新汇率（force=true 绕过 TTL）',
    body: fxCatalogContracts.refresh,
    response: { schema: fxStateSchema },
    errors: [401, 503],
  },
  {
    method: 'put',
    path: '/v1/fx/catalog/override',
    tag: 'fx',
    summary: '手动覆盖汇率（0.01–1000）',
    body: fxCatalogContracts.override,
    response: { schema: fxStateSchema },
    errors: [400, 401],
  },
  {
    method: 'delete',
    path: '/v1/fx/catalog/override',
    tag: 'fx',
    summary: '清除手动覆盖（回到 auto）',
    response: { schema: fxStateSchema },
    errors: [401],
  },
  {
    method: 'put',
    path: '/v1/fx/catalog/buffer',
    tag: 'fx',
    summary: '设置点差 bufferPct（%）',
    body: fxCatalogContracts.buffer,
    response: { schema: fxStateSchema },
    errors: [400, 401],
  },
];
