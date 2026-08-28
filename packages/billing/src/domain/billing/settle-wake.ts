/**
 * 结算唤醒通道契约（生产端 = gateway pg_notify 纯门铃；消费端 = worker
 * LISTEN）。通道名单一真相：生产/消费两侧与
 * db schema billing_requests 注释同源。
 * 丢失语义：唤醒仅负责低延迟触发，PG 是资金唯一事实源——丢失由 worker
 * 兜底扫描覆盖。
 */
export const SETTLE_WAKE_CHANNEL = 'settle-wake';
