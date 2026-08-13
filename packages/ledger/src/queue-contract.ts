/** Redis/BullMQ 只是低延迟通知层；payload 永远不携带账务事实。 */
export const BILLING_SETTLEMENT_QUEUE = 'billing-settlement';

export interface BillingSettlementWakeup {
  requestId: string;
}
