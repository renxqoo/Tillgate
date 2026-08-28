/**
 * @tillgate/billing 公共出口。
 * 金额/指纹基座 + 钱包垂直（domain 定律 + application 动词）。
 * adapters/postgres 不从根出口导出：装配走 ./composition。
 */

// ---- facade（收口） ----
export { createBilling } from './billing.js';
export type { Billing, CreateBillingConfig, BillingStores } from './billing.js';

// ---- 领域错误目录 ----
export { BillingErrors } from './domain/errors.js';

// ---- 金额（全包唯一金额契约） ----
export {
  Decimal,
  toStorage,
  normalizeAmount,
  isValidAmountString,
  parsePositiveAmount,
  parseNonNegativeAmount,
} from './domain/money.js';

// ---- 命令指纹（全包唯一指纹契约） ----
export {
  canonicalJson,
  fingerprintOf,
  commandFingerprint,
  assertCommandFingerprint,
} from './domain/fingerprint.js';
export type { FingerprintValue } from './domain/fingerprint.js';

// ---- 钱包定律（复式过账 / 出账口径 / 冻结单状态机 / 白名单） ----
export { OUTSIDE_ACCOUNT, REVENUE_ACCOUNT } from './domain/wallet/accounts.js';
export type { AccountRef, AccountSnapshot } from './domain/wallet/accounts.js';
export {
  assertRefType,
  assertCurrency,
  assertInternalCode,
  assertRefId,
} from './domain/wallet/guards.js';
export type { WalletGuards } from './domain/wallet/guards.js';
export {
  availableToSpend,
  assertCanDebit,
  assertCreditLimitCoversExposure,
} from './domain/wallet/exposure.js';
export type { DebitGuard } from './domain/wallet/exposure.js';
export { assertSettleable, assertReleasable } from './domain/wallet/authorization.js';
export type { AuthorizationStatus, AuthorizationSnapshot } from './domain/wallet/authorization.js';
export { isAuditKind, validatePosting, legBalanceAfter } from './domain/wallet/posting.js';
export type { TransactionKind, PostingLegSpec, PostingSpec } from './domain/wallet/posting.js';

// ---- 钱包动词（application 编排 + 存储 port） ----
export { createWalletApi } from './application/wallet/wallet.js';
export { BILLING_REF_TYPE } from './application/wallet/authorize.js';
export type { WalletApi, WalletEnv } from './application/wallet/wallet.js';
export type { CreditInput, CreditResult } from './application/wallet/credit.js';
export type { AuthorizeInput, AuthorizeResult } from './application/wallet/authorize.js';
export type { SettleInput, SettleResult } from './application/wallet/settle.js';
export type { ReleaseInput, ReleaseResult } from './application/wallet/release.js';
export type { RefundInput, RefundResult } from './application/wallet/refund.js';
export type { TransferInput, TransferResult } from './application/wallet/transfer.js';
export type {
  SetCreditLimitInput,
  SetCreditLimitResult,
} from './application/wallet/credit-line.js';
export type { SetDebitFloorInput, SetDebitFloorResult } from './application/wallet/debit-floor.js';
export type {
  ApplyDefaultFloorInput,
  ApplyDefaultFloorResult,
} from './application/wallet/debit-floor.js';
export {
  DEBIT_FLOOR_DEFAULT_KEY,
  parseDebitFloorDefault,
} from './application/wallet/debit-floor.js';
export {
  BILLING_RESERVATION_POLICY_KEY,
  parseReservationPolicySetting,
  BILLING_RESERVATION_LIMIT_KEY,
  DEFAULT_RESERVATION_LIMIT,
  parseReservationLimitSetting,
} from './application/billing/reservation-policy.js';
export {
  PLATFORM_CURRENCY_KEY,
  DEFAULT_PLATFORM_CURRENCY,
  parsePlatformCurrencySetting,
} from './application/billing/platform-currency.js';
export type { StatementQuery, StatementItemView } from './application/wallet/statement.js';
export type {
  WalletStore,
  WalletConn,
  TransactionHeader,
  StatementItemRow,
} from './ports/wallet-store.js';

// ---- 计价域（rating——计量/定价策略/预扣策略/公式/收据） ----
export {
  PRICE_PER_MILLION,
  calcAmount,
  estimateMaxCost,
  requiredReservation,
} from './domain/rating/pricing.js';
export type { AmountInput, ReservationEstimateInput } from './domain/rating/pricing.js';
export { calculateFundingReservation, calculateRequired } from './domain/rating/calculate.js';
export type { FundingReservationPolicy } from './domain/rating/calculate.js';
export { computeAmounts } from './domain/rating/amounts.js';
export type { SettleAmounts } from './domain/rating/amounts.js';
export { pickCoefficient } from './domain/rating/coefficient.js';
export type {
  RateCardCoefficientSnapshot,
  CoefficientLookup,
} from './domain/rating/coefficient.js';
export { MEASUREMENTS, measurementOf } from './domain/rating/measurement.js';
export type { MeasurementDescriptor } from './domain/rating/measurement.js';
export { PRICING_STRATEGIES, strategyOf } from './domain/rating/pricing-strategy.js';
export type {
  BillingConfig,
  PricingContext,
  PricingStrategy,
  PriceOverrides,
} from './domain/rating/pricing-strategy.js';
export {
  matchPricingWindow,
  minuteOfDayInZone,
  validateScheduleWindows,
  windowLabelOf,
} from './domain/rating/schedule.js';
export type { PricingWindow, ScheduleWindowsIssue } from './domain/rating/schedule.js';
export {
  RESERVATION_STRATEGIES,
  reservationStrategyOf,
} from './domain/rating/reservation-strategy.js';
export type {
  ReservationPolicyConfig,
  ReservationStrategy,
} from './domain/rating/reservation-strategy.js';
export { decodeReceipt, finiteDecimal } from './domain/rating/decode.js';
export { validateReceipt } from './domain/rating/receipt.js';
export {
  USER_SIDE_CANCELS,
  ESTIMATE_ATTRIBUTIONS,
  streamEstimateAttribution,
  isAttributedEstimate,
} from './domain/rating/types.js';
export type {
  UsageReceipt,
  UserSideCancel,
  EstimateAttribution,
  BillingQuoteCandidate,
  BillingQuote,
} from './domain/rating/types.js';

// ---- 计费域（billing——状态机/限额/分配/失败策略/订阅闸） ----
export { isTerminal } from './domain/billing/reservation.js';
export type { BillingStatus } from './domain/billing/reservation.js';
export { allocateSettlement } from './domain/billing/settle-allocation.js';
export type { ReservationShare, SettleShare } from './domain/billing/settle-allocation.js';
export { settleFailurePolicy, isDeadLetterFamily } from './domain/billing/settle-failure.js';
export type {
  SettleFailureDecision,
  SettleFailurePolicyConfig,
  SettleFailurePolicyInput,
} from './domain/billing/settle-failure.js';
export {
  billingDayStart,
  billingMonthStart,
  billingDayKey,
  secondsUntilNextBillingDay,
} from './domain/billing/daily-window.js';
export { assertDailySpendLimit } from './domain/billing/daily-limit.js';
export type { DailyLimitCheck } from './domain/billing/daily-limit.js';
export { subscriptionAvailability } from './domain/billing/subscription-availability.js';
export type {
  SubscriptionGateSnapshot,
  SubscriptionGateInput,
} from './domain/billing/subscription-availability.js';

// ---- 计费授权链（authorize/signal/admission/reserveChannel + 资金瀑布） ----
export {
  createBillingApi,
  createBillingAdmission,
  createDefaultFundingRegistry,
} from './application/billing/billing.js';
export type { BillingApi, BillingDeps } from './application/billing/billing.js';
export type {
  AuthorizeBillingInput,
  BillingAuthorization,
  BillingEvent,
  BillingSignalResult,
  ReserveChannelInput,
  ChannelReservationResult,
  BacklogAdmissionConfig,
} from './application/billing/billing.js';
export { createFundingRegistry } from './application/billing/funding/registry.js';
export type { FundingRegistry } from './application/billing/funding/registry.js';
export { createPaygSource } from './application/billing/funding/payg-source.js';
export { createSubscriptionSource } from './application/billing/funding/subscription-source.js';
export type {
  FundingSource,
  FundingSourceContext,
  SourceReservation,
  SourceType,
  ProbeInput,
  ReserveInput,
  SourceSettleInput,
} from './application/billing/funding/source.js';
export type {
  FundingPlan,
  FundingPlanEntry,
  PlanFundingInput,
} from './application/billing/funding/plan.js';
export type {
  BillingRequestRow,
  BillingReservationRow,
  BillingStore,
} from './ports/billing-store.js';
export type {
  FundingSourceResolver,
  ResolvedFundingSource,
  SubscriptionQuotaStore,
  SubscriptionSnapshot,
  ChannelExposureStore,
} from './ports/funding-ports.js';
// 事务参与 port：可靠通知同事务入箱——app assembly 桥接 notifications outbox
export type { NotificationOutboxPort, OutboxFact } from './ports/notification-outbox.js';
export { reserveDecision, budgetRemaining } from './domain/billing/channel-exposure.js';
export type { ChannelReserveDecision } from './domain/billing/channel-exposure.js';

// ---- 结算与恢复（./settlement 窄子入口的装配体） ----
export { createSettlementApi } from './application/settlement/settlement.js';
export type {
  SettlementApi,
  SettlementDeps,
  SettlementClaim,
  ClaimInput,
  ClaimOutcome,
  SettleClaimResult,
  RecoveryRunResult,
  ReconcileReport,
  ReconcileViolation,
} from './application/settlement/settlement.js';
export { createClaimUseCase, createRenewClaimsUseCase } from './application/settlement/claim.js';
export { createSettleClaimUseCase } from './application/settlement/settle.js';
export { createFailureUseCase } from './application/settlement/failure.js';
export { createProcessClaimUseCase } from './application/settlement/process.js';
export {
  createRecoverUseCase,
  createAbandonClaimsUseCase,
} from './application/settlement/recover.js';
export { createReconcileUseCase } from './application/settlement/reconcile.js';
export { usageLogProjection } from './application/settlement/usage-projection.js';
export type { UsageProjectionInput } from './application/settlement/usage-projection.js';
export { createRecordDiscrepanciesUseCase } from './application/settlement/record-discrepancies.js';

// ---- worker 消费面（佣金日结 / 对账差异落表 / 结算唤醒通道） ----
export { createReferralCommissionUseCase } from './application/referral-commission.js';
export type {
  ReferralCommissionDeps,
  ReferralCommissionResult,
  CommissionWallet,
} from './application/referral-commission.js';
export type { CommissionStatsStore, InviteeSpendByInviter } from './ports/commission-stats.js';
export type {
  ReconcileDiscrepancyRow,
  ReconcileDiscrepancyStore,
} from './ports/reconcile-store.js';
export { SETTLE_WAKE_CHANNEL } from './domain/billing/settle-wake.js';

// ---- 订阅生命周期与幂等操作档案 ----
export {
  renewalStart,
  periodEnd,
  remainingQuota,
  remainingValue,
  changeDiff,
  assertChangeEligibility,
  assertSeatsAllowed,
  assertValidQuantity,
} from './domain/subscription/rules.js';
export type { QuotaSnapshot } from './domain/subscription/rules.js';
export { createOperationsUseCase, assertOperationId } from './application/operations.js';
export type { OperationRun } from './application/operations.js';
export { createSubscriptionsApi } from './application/subscriptions/subscriptions.js';
export type {
  SubscriptionsApi,
  SubscriptionsEnv,
  SubscribeResult,
  PurchaseInput,
  RenewInput,
  ChangeInput,
  CancelInput,
  GrantPackInput,
  GrantPackResult,
} from './application/subscriptions/subscriptions.js';
export type { SubscriptionRow } from './ports/billing-store.js';
export type { AccountContextStore } from './ports/account-context.js';

// ---- 管理读侧面（plans 目录 / 订阅管理列表 / 兑换批次 / 死信复核） ----
export type { PlansApi } from './billing.js';
export type { ListPlansQuery } from './application/plans/list-plans.js';
export type { CreatePlanInput } from './application/plans/create-plan.js';
export type { UpdatePlanInput } from './application/plans/update-plan.js';
export type { PlanRecord, AdminSubscriptionRow, DeadCaseRow } from './ports/billing-store.js';
export type {
  RetryDeadInput,
  RetryDeadResult,
} from './application/settlement/review/retry-dead.js';
export type {
  AbandonDeadInput,
  AbandonDeadResult,
} from './application/settlement/review/abandon-dead.js';
export type {
  ReviewCommand,
  ReviewAuditTx,
} from './application/settlement/review/review-shared.js';
export { createRedeemBatchApi } from './application/redeem-batches/redeem-batches.js';
export type {
  RedeemBatchesApi,
  CreateBatchInput,
  CreateBatchResult,
  ListBatchesQuery,
  ListCodesQuery,
} from './application/redeem-batches/redeem-batches.js';
export type { RedeemBatchRecord, RedeemCodeRecord } from './ports/payment-ports.js';

// ---- 支付与兑换 ----
export {
  isValidAmountInput,
  assertTopupWithinLimit,
  computeCreditAmount,
  amountsMatch,
} from './domain/payment/topup.js';
export { epaySign, epayVerify, parseEpayNotify, EPAY_PAY_TYPES } from './domain/payment/epay.js';
export type { EpayNotifyPayload, EpayPayType } from './domain/payment/epay.js';
export {
  stripeMinorUnitsFromAmount,
  stripeAmountFromMinorUnits,
  STRIPE_ZERO_DECIMAL_CURRENCIES,
  parseStripeSignatureHeader,
  verifyStripeSignature,
  parseStripeEvent,
  STRIPE_WEBHOOK_TOLERANCE_S,
} from './domain/payment/stripe.js';
export type { StripeCheckoutEvent, StripeSignatureParts } from './domain/payment/stripe.js';
export { createPaymentsApi, PROVIDER_LABELS } from './application/payments/payments.js';
export type { PaymentsDeps, PaymentsApi } from './application/payments/payments.js';
export { createPaymentAdminApi } from './application/payments/payment-admin.js';
export type {
  PaymentAdminApi,
  PaymentAdminDeps,
  PaymentAdminQuery,
} from './application/payments/payment-admin.js';
export { createRedemptionApi, sha256Hex } from './application/redemption/redemption.js';
export type { RedemptionDeps, RedemptionApi } from './application/redemption/redemption.js';
export type {
  PaymentProviderPort,
  PaymentOrderStore,
  PaymentOrderRow,
  AdminPaymentOrderRow,
  PaymentOrderSortField,
  RedeemCodeStore,
  RedeemClaimRow,
  RateCounterPort,
} from './ports/payment-ports.js';
export { PAYMENT_ORDER_SORT_FIELDS } from './ports/payment-ports.js';
