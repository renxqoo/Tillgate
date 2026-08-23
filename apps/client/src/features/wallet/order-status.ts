/**
 * 支付单状态映射（D4 单处表驱动）：状态码 → i18n key + pill tone。
 * 词表与 billing 域 PaymentOrderRow 状态注释同源：
 * 0 created / 1 paid / 2 credited / 3 refunded / 4 expired。
 */
export const ORDER_STATUS_KEYS: Record<number, string> = {
  0: 'statusPending',
  1: 'statusPaid',
  2: 'statusCredited',
  3: 'statusRefunded',
  4: 'statusClosed',
};

export const ORDER_STATUS_TONES: Record<number, 'success' | 'warning' | 'neutral'> = {
  0: 'warning',
  1: 'warning',
  2: 'success',
  3: 'neutral',
  4: 'neutral',
};
