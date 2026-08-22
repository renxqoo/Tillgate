/**
 * 通知事件词表(封闭单一真相,DESIGN §2.2):
 * v1 散落在 admin service(NOTIFY_EVENTS)且网关/worker 直插 outbox 可绕过(B5)——
 * v2 入箱(enqueue/test)与渠道订阅校验统一走本词表;新增事件 = 契约变更,须同步 DESIGN。
 * db 层不加 event CHECK:保留测试合成事件走 store 层的能力(DDL 不动,v1 语义)。
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
