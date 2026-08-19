/**
 * @ai-gateway/ledger/channel-budget —— 渠道运营资金域出口（S4）。
 *
 * 渠道采购预算（进货/调账）、上游敞口预留/释放（换渠原子替换）、结算成本
 * 扣减与熔断。自治运营资金域：channels.upstream_budget 是公司采购预算，
 * 与用户资金永不混账（plan §7 / §11 Q3 拍板）；未来进总账预留
 * platform_revenue → channel_cost 的 wallet.transfer 结转路径。
 */
import { createDomainOperations } from '../platform/operations.js';
import { adjustChannel, rechargeChannel } from './recharge.js';
import type { ChannelBudget, ChannelBudgetContext, ChannelBudgetDeps } from './types.js';
import { CHANNEL_BUDGET_OPERATION_KINDS } from './types.js';

export function createChannelBudget(deps: ChannelBudgetDeps): ChannelBudget {
  const ctx: ChannelBudgetContext = {
    db: deps.db,
    operations: createDomainOperations(deps.db, CHANNEL_BUDGET_OPERATION_KINDS),
    clock: deps.clock ?? (() => new Date()),
  };
  return {
    recharge: (input) => rechargeChannel(ctx, input),
    adjust: (input) => adjustChannel(ctx, input),
  };
}

export { rechargeChannel, adjustChannel, adjustWouldBeNegative } from './recharge.js';
export { reserveExposure } from './exposure.js';
export { releaseExposure, deductBudget } from './closeout.js';
export type { ExposureProjection } from './closeout.js';
export { ChannelBudgetError } from '../platform/errors.js';
export type {
  ChannelBudget,
  ChannelBudgetDeps,
  ReserveChannelCommand,
  ChannelReservationResult,
} from './types.js';
