/**
 * 跨能力只读探针(billing/gateway 消费;为防环,billing 不回查 accounts 内部对象,
 * 只经这些窄读)。均为单语句透传,共置一文件(同一消费场景)。
 */
import type { UseCaseContext } from './context.js';

/** 用户存在性(订阅购买属主校验等) */
export function userExists(ctx: UseCaseContext, userId: number): Promise<boolean> {
  return ctx.store.userExists(ctx.db, userId);
}

/** 企业资格(团队套餐闸) */
export function userIsEnterprise(ctx: UseCaseContext, userId: number): Promise<boolean> {
  return ctx.store.userIsEnterprise(ctx.db, userId);
}

/** 用户费率卡绑定(报价快照;null=系数 1) */
export function userRateCardBinding(ctx: UseCaseContext, userId: number): Promise<number | null> {
  return ctx.store.userRateCardBinding(ctx.db, userId);
}

/** 组织成员限额读模型(订阅授权管线 probe;日限/子配额) */
export function memberLimits(
  ctx: UseCaseContext,
  input: { orgId: number; userId: number },
): Promise<{ dailySpendLimit: string | null; monthlyQuota: string | null } | null> {
  return ctx.store.memberLimits(ctx.db, input);
}
