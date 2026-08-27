/**
 * 通知事件词表(封闭单一真相):
 * 入箱(enqueue/test)与渠道订阅校验统一走本词表;新增事件 = 契约变更。
 * db 层不加 event CHECK:保留测试合成事件走 store 层的能力。
 */

export const NOTIFY_EVENTS = [
  'channel_disabled',
  'reconcile_discrepancy',
  'billing_dead',
  'balance_low',
  'context_overflow',
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** 词表成员判定(渠道订阅/入箱共用) */
export function isNotifyEvent(value: string): value is NotifyEvent {
  return (NOTIFY_EVENTS as readonly string[]).includes(value);
}
