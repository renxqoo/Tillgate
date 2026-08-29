/**
 * 智能路由策略域契约。
 * 策略体形状单一真相 = @tillgate/inference routingPolicySchema（引用不复制——
 * 网关读侧同 schema parse）；本文件只收口 HTTP 请求面：PUT body 的 policy +
 * note 边界。查询面 windowMs 的运行时容错（非法值回落 1h）在 route 内联，
 * 不做 400（观测接口参数永不拒请求）。
 */
import * as z from 'zod';
import { routingPolicySchema } from '@tillgate/inference';

export const routingPolicyContracts = {
  /** PUT /v1/routing-policy 请求体（policy 经 inference schema 单一真相；note 边界在此收口） */
  save: z.object({
    policy: routingPolicySchema,
    note: z.string().max(255).optional(),
  }),
} as const;

export type SaveRoutingPolicyRequest = z.infer<typeof routingPolicyContracts.save>;
