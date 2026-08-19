/**
 * @ai-gateway/ledger/rating —— 计价域出口（S2）。
 * 报价与最坏费用授权推导、结算金额双口径（用户实扣 / 官方价渠道成本）、
 * 费率卡系数解析、durable receipt 验收——纯函数为主，无资金写动作。
 * 依赖方向：rating → { wallet/metering, platform }；不依赖 billing/settlement。
 */
export * from './types.js';
export { calculateRequired, validateReceipt } from './quote.js';
export { computeAmounts } from './amounts.js';
export type { SettleAmounts } from './amounts.js';
export * from './coefficient.js';
