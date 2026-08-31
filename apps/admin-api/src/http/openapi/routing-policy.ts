/**
 * 智能路由策略域 OpenAPI registry（routes/routing-policy.ts 契约面）。
 * 请求 schema 引用 contracts/routing-policy.ts；响应 wire 形状在此声明
 * （策略体内嵌 @tillgate/inference routingPolicySchema 的 JSON 形状——生成链
 * 经 z.toJSONSchema 取 min/max/default，refinement 检查不出现在文档面）。
 */
import * as z from 'zod';
import { routingPolicySchema } from '@tillgate/inference';
import { routingPolicyContracts } from '../contracts/routing-policy';
import type { OpenApiEndpoint } from './shared';

/** routing_policies global 行投影（GET /v1/routing-policy 已配置分支） */
export const routingPolicyRecordSchema = z
  .object({
    version: z.string().describe('策略版本（每次保存行级自增——观测/回滚锚点）'),
    policy: routingPolicySchema.describe('当前生效策略体（五段结构）'),
    note: z.string().nullable().describe('变更备注（最近一次保存）'),
    updatedBy: z.string().nullable().describe('最近保存人（管理员标识）'),
    updatedAt: z.string().describe('最近保存时刻（ISO 时间串）'),
  })
  .meta({
    id: 'RoutingPolicyRecord',
    description: '路由策略记录（GET /v1/routing-policy 已配置分支）',
  });

/** 未配置分支：编译期缺省策略随响应携带（前端表单初值——不依赖 inference 运行时） */
export const routingPolicyDefaultsSchema = z
  .object({
    unconfigured: z.literal(true),
    policy: routingPolicySchema.describe('编译期缺省策略（zod 内建 default 全展开）'),
  })
  .meta({
    id: 'RoutingPolicyDefaults',
    description: '路由策略未配置回执（GET /v1/routing-policy 无 global 行时）',
  });

/** PUT 保存回执（version 为落库自增结果） */
export const routingPolicySaveReceiptSchema = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    savedAt: z.string(),
  })
  .meta({
    id: 'RoutingPolicySaveReceipt',
    description: '路由策略保存回执（PUT /v1/routing-policy）',
  });

/** 近窗渠道观测行（control-plane routingChannelsOverview 投影——金额 numeric 字符串） */
export const routingOverviewRowSchema = z
  .object({
    channelId: z.number(),
    channelName: z.string(),
    status: z.number().describe('0 启用/1 禁用/2 维护/3 熔断/4 凭据无效'),
    priority: z.number().nullable(),
    weight: z.number().describe('渠道层路由权重（D4 单轨——priority 层内加权分布）'),
    upstreamBudget: z.string().describe('进货总额（元，numeric 字符串）'),
    upstreamRemaining: z.string().describe('剩余 = 进货 - 已占用（元，numeric 字符串）'),
    requests: z.number().describe('近窗请求数（billing_requests 生命周期口径）'),
    failures: z.number().describe('近窗失败数（released 且带失败原因口径）'),
    avgDurationMs: z.number().nullable().describe('近窗平均上游耗时（usage_logs 结算口径）'),
    avgClientTtftMs: z.number().nullable().describe('近窗平均客户端首字延迟'),
    cachedInputTokens: z.number().describe('近窗缓存命中输入 token（结算口径）'),
    inputTokens: z.number().describe('近窗输入 token 总量（结算口径）'),
  })
  .meta({
    id: 'RoutingOverviewRow',
    description: '渠道路由观测行（GET /v1/routing/channels-overview）',
  });

export const routingPolicyEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/routing-policy',
    tag: 'routing',
    summary: '当前生效路由策略（未配置时携带编译期缺省）',
    response: {
      schema: z.union([routingPolicyRecordSchema, routingPolicyDefaultsSchema]),
      description: '已配置 = RoutingPolicyRecord；未配置 = RoutingPolicyDefaults',
    },
    errors: [401],
  },
  {
    method: 'put',
    path: '/v1/routing-policy',
    tag: 'routing',
    summary: '保存全局路由策略（version 自增 + 审计；网关 TTL 拾取热生效）',
    body: routingPolicyContracts.save,
    response: { schema: routingPolicySaveReceiptSchema },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/routing/channels-overview',
    tag: 'routing',
    summary: '近窗渠道路由观测（调参依据；windowMs 非法值回落 1h）',
    query: z.object({
      windowMs: z.coerce
        .number()
        .int()
        .min(1)
        .max(86_400_000)
        .optional()
        .describe('观测窗口毫秒（缺省 3_600_000；越界/非法运行时回落缺省不 400）'),
    }),
    response: { schema: z.object({ rows: z.array(routingOverviewRowSchema) }) },
    errors: [401],
  },
];
