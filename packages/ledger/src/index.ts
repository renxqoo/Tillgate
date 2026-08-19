/**
 * @ai-gateway/ledger —— 账本域根出口：只放各域装配工厂的再导出（plan §2）。
 *
 *   platform/        错误单一家谱 / HTTP 映射 / 幂等执行器
 *   rating/          报价、费率卡系数、最坏/实际费用、收据校验
 *   subscription/    套餐生命周期 + 额度原语（资金全走 wallet）
 *   channel-budget/  渠道运营资金（进货/调账/敞口/熔断，自治域）
 *   billing/         billing_requests 状态机编排（钱包之上）
 *   settlement/      worker 结算编排（认领/租约/重试/恢复）
 *
 * 依赖铁律：settlement → billing → {subscription, rating, channel-budget}
 * → {wallet, ledger-core}；platform 被所有域引用。消费方优先从子导出
 * （'@ai-gateway/ledger/billing' 等）精确引用。
 */
export * from './platform/index.js';
export * from './rating/index.js';
export { createBillingDomain, newLeaseOwner } from './billing/domain.js';
export type { BillingDomain, BillingDomainDeps } from './billing/domain.js';
export { createSubscriptionDomain } from './subscription/index.js';
export type { SubscriptionDomain, SubscriptionDeps } from './subscription/index.js';
export { createChannelBudget } from './channel-budget/index.js';
export type { ChannelBudget, ChannelBudgetDeps } from './channel-budget/index.js';
export { createSettlementProcessor, newProcessorOwnerId, createRedisBillingEffects, BILLING_SETTLEMENT_QUEUE } from './settlement/index.js';
export type { SettlementProcessor, SettlementProcessorDeps, BillingSettlementWakeup } from './settlement/index.js';
export { billingDayStart, billingDayKey, secondsUntilNextBillingDay } from './billing/daily-window.js';
export type * from './billing/types.js';
export { runOpeningMigration, listUsersWithLegacyBalance, activeBillingCount } from './migration/opening.js';
export type { OpeningMigrationReport } from './migration/opening.js';
