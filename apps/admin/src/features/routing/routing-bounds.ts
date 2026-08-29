/**
 * 路由策略表单数值边界（routingPolicySchema 的前端镜像）。
 * 单一真相 = @tillgate/inference routingPolicySchema；admin 不依赖能力包
 * （架构定位「零能力包直依赖」），故以常量表镜像 + 对照测试锁定：
 * __test__/routing-bounds.test.ts 逐字段断言本表与 admin-api 入库交付物
 * generated/openapi.json（schema 经生成链展开，逐字节锁定）一致——schema 改
 * 边界而本表未跟即红。不要在别处内联这些数字。
 */
export interface RoutingFormFieldBound {
  /** 允许最小值（含） */
  readonly min: number;
  /** 允许最大值（含） */
  readonly max: number;
  /** schema 为整数约束（z.number().int()） */
  readonly integer: boolean;
}

export const ROUTING_FORM_BOUNDS: Readonly<
  Record<
    | 'cacheBoost'
    | 'softRatio'
    | 'sameChannelMaxRetries'
    | 'rateLimitBaseMs'
    | 'rateLimitMaxMs'
    | 'quotaMs'
    | 'modelDeadThreshold'
    | 'maxWaitMs',
    RoutingFormFieldBound
  >
> = {
  cacheBoost: { min: 1, max: 5, integer: false },
  softRatio: { min: 0.01, max: 1, integer: false },
  sameChannelMaxRetries: { min: 1, max: 6, integer: true },
  rateLimitBaseMs: { min: 100, max: 60_000, integer: true },
  rateLimitMaxMs: { min: 1_000, max: 600_000, integer: true },
  quotaMs: { min: 10_000, max: 86_400_000, integer: true },
  modelDeadThreshold: { min: 2, max: 10, integer: true },
  maxWaitMs: { min: 100, max: 5_000, integer: true },
};
