/**
 * 目录域 OpenAPI registry（routes/catalog.ts 契约面）。
 * 请求 schema 引用 contracts/catalog.ts;响应 wire 形状按 control-plane catalog
 * 用例返回面声明（CatalogComparisonPayload/价格溯源/导入回执）。
 */
import * as z from 'zod';
import { catalogContracts } from '../contracts/catalog';
import type { OpenApiEndpoint } from './shared';

/** 汇率状态投影（control-plane FxState;目录比对与汇率面共用形状） */
export const fxStateSchema = z.object({
  mode: z.enum(['auto', 'override']).describe('override=手动钉死'),
  baseRate: z.string().nullable().describe('基准（1 USD = ? CNY；请求收据快照的是它）'),
  effectiveRate: z
    .string()
    .nullable()
    .describe('预填换算用生效汇率 = base ×(1+buffer/100)；base 缺失时 null（UI 只展示目录原价）'),
  bufferPct: z.string(),
  source: z.string().nullable(),
  fxRateId: z.number().nullable(),
  fetchedAt: z.string().nullable(),
});

/** 目录源清单行（GET /v1/model-catalog/sources） */
const catalogSourceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['channel', 'reference']),
  priceCurrency: z.enum(['USD', 'CNY']),
});

/** 目录比对项（CatalogComparison & 预填换算价） */
const catalogComparisonItemSchema = z.object({
  realModel: z.string().describe('上游真实模型 id(channel 源)或 provider/id 唯一化(reference 源)'),
  displayName: z.string(),
  contextLength: z.number().nullable(),
  currency: z.enum(['USD', 'CNY']),
  catalogPrompt: z.string().describe('目录参考输入价(源币种/百万 token;"0"=免费)'),
  catalogCompletion: z.string(),
  catalogCacheRead: z.string().nullable(),
  catalogCacheWrite: z.string().nullable(),
  suggestedName: z.string().describe('对外名建议(去厂商前缀与 :free 后缀)'),
  imported: z
    .object({ externalName: z.string(), inputPrice: z.string(), outputPrice: z.string() })
    .nullable()
    .describe('已导入回填（我们的卖价，CNY）'),
  diff: z.enum(['new', 'same', 'price_up', 'price_down']).describe('目录价与库内卖价的差异态'),
  driftPct: z.number().nullable().describe('目录换算价相对我们卖价的偏离(%,正=上游比我们贵)'),
  isFree: z.boolean().describe('免费判定：目录输入输出价均为 0'),
  priceWarning: z.boolean().describe('目录收费而我们免费卖 → 亏钱风险，页面标红'),
  prefillInputCny: z
    .string()
    .nullable()
    .describe('预填输入价(按 effectiveRate 换算;汇率不可用为 null)'),
  prefillOutputCny: z.string().nullable(),
});

/** 目录比对响应（GET /v1/model-catalog/:sourceId） */
const catalogComparisonSchema = z.object({
  source: z.string(),
  kind: z.enum(['channel', 'reference']),
  priceCurrency: z.enum(['USD', 'CNY']),
  fetchedAt: z.string(),
  fx: fxStateSchema,
  channelReady: z.boolean(),
  channelRpmLimit: z.number().nullable(),
  items: z.array(catalogComparisonItemSchema),
  gone: z
    .array(z.object({ mappingId: z.number(), externalName: z.string(), realModel: z.string() }))
    .describe('channel 源专属：绑定到本源渠道但目录已无的映射（复核下架用）'),
});

/** 价格溯源条目（GET /v1/model-catalog/price-history） */
const priceHistoryEntrySchema = z.object({
  action: z.string(),
  createdAt: z.string(),
  adminId: z.number().nullable(),
  fx: z
    .object({
      baseRate: z.string(),
      effectiveRate: z.string().nullable(),
      source: z.string().nullable(),
      fetchedAt: z.string().nullable(),
    })
    .nullable(),
  catalogPrompt: z.string().nullable(),
});

export const catalogEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/model-catalog/sources',
    tag: 'model-catalog',
    summary: '目录源清单（装配注入的源货架）',
    response: { schema: z.object({ sources: z.array(catalogSourceInfoSchema) }) },
    errors: [401],
  },
  {
    method: 'get',
    path: '/v1/model-catalog/price-history',
    tag: 'model-catalog',
    summary: '模型价格溯源（审计投影）',
    query: z.object({
      externalName: z.string().min(1).max(64).describe('对外模型名(必填)'),
    }),
    response: { schema: z.object({ entries: z.array(priceHistoryEntrySchema) }) },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/model-catalog/:sourceId',
    tag: 'model-catalog',
    summary: '拉取目录并比对库内映射（三态 diff + 换算预填）',
    params: [
      {
        name: 'sourceId',
        description: '目录源 id（词表外 → 404,不泄漏源清单）',
        schema: z.string().regex(/^[a-z0-9-]{1,32}$/),
      },
    ],
    response: { schema: catalogComparisonSchema },
    errors: [401, 404, 502, 504],
  },
  {
    method: 'post',
    path: '/v1/model-catalog/import',
    tag: 'model-catalog',
    summary: '一键导入目录模型（价格必填——提交即确认,防 0 卖亏钱）',
    body: catalogContracts.import,
    response: {
      schema: z.object({
        providerId: z.number().nullable(),
        channelId: z.number().nullable(),
        created: z.number(),
        updated: z.number(),
        skipped: z.number(),
      }),
    },
    errors: [400, 401, 409],
  },
  {
    method: 'get',
    path: '/v1/vendor-catalog',
    tag: 'model-catalog',
    summary: '协议 + 厂商档案词表（创建 Provider 表单两下拉单一真相;装配自 ai 根出口）',
    response: {
      schema: z.object({
        protocols: z.array(z.string()),
        vendors: z.array(z.string()),
      }),
    },
    errors: [401],
  },
];
