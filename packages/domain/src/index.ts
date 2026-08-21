/**
 * @ai-gateway/domain —— 领域规则层（全部业务纯函数）。
 *
 * 分层契约：service → domain → repository → db。本包是纯逻辑层：
 * 零 SQL、零 DB、零框架，运行时依赖仅 decimal.js 与 node: 内建
 * （__tests__/architecture.test.ts 机器强制）。
 * 域内方向：shared ← wallet ← rating ← billing / channel-budget，只许向下引用。
 */
export * from './shared/errors.js';
export * from './shared/operation-id.js';

export * from './wallet/money.js';
export * from './wallet/accounts.js';
export * from './wallet/errors.js';
export * from './wallet/account.js';
export * from './wallet/authorization.js';
export * from './wallet/fingerprint.js';
export * from './wallet/posting.js';
export * from './wallet/guards.js';

export * from './billing/errors.js';
export * from './billing/reservation.js';
export * from './billing/daily-window.js';
export * from './billing/settle-allocation.js';
export * from './billing/settle-failure.js';
export * from './billing/subscription-availability.js';
export * from './billing/daily-limit.js';

export * from './rating/types.js';
export * from './rating/errors.js';
export * from './rating/pricing.js';
export * from './rating/coefficient.js';
export * from './rating/calculate.js';
export * from './rating/receipt.js';
export * from './rating/amounts.js';
export * from './rating/decode.js';
export * from './rating/measurement.js';
export * from './rating/pricing-strategy.js';
export * from './rating/reservation-strategy.js';

export * from './channel-budget/errors.js';
export * from './channel-budget/reserve-rule.js';
export * from './generation/kinds.js';
export * from './subscription/errors.js';
export * from './subscription/rules.js';
