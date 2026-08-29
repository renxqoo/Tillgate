/**
 * 模型映射域 OpenAPI registry（routes/models.ts 契约面）。
 * 请求 schema 引用 contracts/models.ts;响应 wire 形状在此声明
 * （与 presenters/models.ts 投影逐字段对齐——价格恒十进制字符串）。
 */
import * as z from 'zod';
import { modelsContracts } from '../contracts/models';
import { idPathParam, listQuery, paginatedOf, okTrue, type OpenApiEndpoint } from './shared';
import { channelTestResultSchema } from './control-plane';

/** 管理面模型映射行（channels 绑定回显;无绑定 = 空数组） */
export const adminModelRowSchema = z
  .object({
    id: z.number(),
    externalName: z.string(),
    realModel: z.string(),
    inputPrice: z.string(),
    outputPrice: z.string(),
    cacheInputPrice: z.string(),
    cacheWritePrice: z.string(),
    pricingUnit: z
      .string()
      .optional()
      .describe('计价单位(token/image/second/char/request)——单位计价模型 2026-08-21 管理面通道'),
    unitPrice: z.string().optional().describe('单位单价(元/张·秒·字符·次;token 模型 0)'),
    billingConfig: z
      .object({
        strategy: z.string().optional(),
        params: z
          .object({
            unitPrice: z.string().optional(),
            selector: z.string().optional(),
            prices: z.record(z.string(), z.string()).optional(),
          })
          .optional(),
      })
      .nullable()
      .optional()
      .describe('变体价格配置(分辨率差价):strategy=variant + params.{selector, prices}'),
    isFree: z.boolean(),
    contextLength: z.number().nullable(),
    fallbackModels: z.string().nullable().describe('兜底模型清单(无来源,恒 null)'),
    paramRules: z.string().nullable().describe('参数规则(无来源,恒 null)'),
    billingPolicy: z.record(z.string(), z.unknown()).nullable(),
    rpmLimit: z.number().nullable(),
    tpmLimit: z.number().nullable(),
    status: z.number(),
    deletedAt: z.string().nullable().describe('记录面逻辑删除时刻(回收站);null = 在册'),
    createdAt: z.string(),
    updatedAt: z.string(),
    channels: z
      .array(
        z.object({
          channelId: z.number(),
          upstreamModel: z
            .string()
            .describe('该渠道的出站模型名(厂商异名;缺省 = 映射规范名 realModel)'),
        }),
      )
      .describe('已绑定渠道(含出站模型名;供「绑定渠道」弹窗回显已选与异名)'),
  })
  .meta({
    id: 'AdminModelRow',
    description: '管理面模型映射行(GET /v1/models;channels 绑定回显)',
  });

export const modelsEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/models',
    tag: 'models',
    summary: '模型映射列表（channels 绑定回显；view=deleted = 回收站）',
    query: listQuery(z.object({ view: z.enum(['active', 'deleted']).optional() })),
    response: { schema: paginatedOf(adminModelRowSchema) },
    errors: [400, 401],
  },
  {
    method: 'post',
    path: '/v1/models',
    tag: 'models',
    summary: '创建模型映射（价格精确十进制字符串）',
    body: modelsContracts.create,
    response: { schema: adminModelRowSchema, status: 201 },
    errors: [400, 401, 409],
  },
  {
    method: 'patch',
    path: '/v1/models/:id',
    tag: 'models',
    summary: '更新模型映射',
    params: [idPathParam('模型映射 id')],
    body: modelsContracts.update,
    response: { schema: adminModelRowSchema },
    errors: [400, 401, 404, 409],
  },
  {
    method: 'delete',
    path: '/v1/models/:id',
    tag: 'models',
    summary:
      '删除模型映射（逻辑删除/回收站：记录与绑定保留，外部名释放可复用；下架走 PATCH status=1）',
    params: [idPathParam('模型映射 id')],
    response: { schema: okTrue },
    errors: [401, 404, 409],
  },
  {
    method: 'post',
    path: '/v1/models/:id/restore',
    tag: 'models',
    summary: '恢复已删除的模型映射（回收站取出，回下架态不直接上架；在册行调用 → 404）',
    params: [idPathParam('模型映射 id')],
    response: { schema: okTrue },
    errors: [401, 404],
  },
  {
    method: 'post',
    path: '/v1/models/:id/channels',
    tag: 'models',
    summary: '绑定渠道全量替换（空数组 = 解绑全部;上限 500;upstreamModel 留空 = 映射规范名）',
    params: [idPathParam('模型映射 id')],
    body: modelsContracts.bind,
    response: { schema: z.object({ ok: z.literal(true), bound: z.number() }) },
    errors: [400, 401, 404],
  },
  {
    method: 'post',
    path: '/v1/models/:id/test',
    tag: 'models',
    summary: '模型最小成本生成探针（"1" + max_tokens=1 真实请求）',
    params: [idPathParam('模型映射 id')],
    response: { schema: channelTestResultSchema },
    errors: [401, 404, 502, 504],
  },
];
