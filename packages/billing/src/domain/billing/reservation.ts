/**
 * 计费状态机（纯函数）：
 * 预扣的真相在 billing_reservations 明细（每来源一行），释放/结算按明细逐笔走；
 * billing_requests 的三列投影非真相源（真相在明细，投影仅作兼容保留）。
 */
/** billing 在 wallet 侧的幂等键域（refType）：authorize 预扣 / 释放与 guards 白名单共用同一份 */
export const BILLING_REF_TYPE = 'billing';

export type BillingStatus =
  | 'authorized'
  | 'in_flight'
  | 'settlement_pending'
  | 'processing'
  | 'retry_wait'
  | 'settled'
  | 'released'
  | 'dead';

/** 终态判定（settled/released 不可再迁移；dead 仅人工复核出口） */
export function isTerminal(status: BillingStatus): boolean {
  return status === 'settled' || status === 'released';
}
