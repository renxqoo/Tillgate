/** channel-budget 域错误家谱：运营资金（公司采购预算），与用户资金永不混账。 */
export class ChannelBudgetError extends Error {
  constructor(
    public readonly code: 'channel_not_found' | 'insufficient_budget' | 'invalid_amount',
    message: string = code,
  ) {
    super(message);
    this.name = 'ChannelBudgetError';
  }
}

/** 敞口/预算不变量破坏（红灯）：渠道在途与账单投影脱节 */
export class ChannelExposureInvariantError extends Error {
  constructor(public readonly detail: string) {
    super(`channel exposure invariant violated: ${detail}`);
    this.name = 'ChannelExposureInvariantError';
  }
}
