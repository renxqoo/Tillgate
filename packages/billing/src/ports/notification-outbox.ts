/**
 * 事务参与 port（总纲 §5.4「消费方定义的事务参与 port」）：可靠通知同事务入箱。
 *
 * billing 在结算/死信业务事务提交前调用 append——入箱失败抛错 → 整个业务事务
 * 回滚（资金事实与通知事实原子，不存在「已结算但无人知晓」的窗口）。
 * 消费方 = app assembly 桥接 notifications outbox：把本 port 的实现写成
 * 「向 notify_outbox 插一行（同 DbTx）」；本包不依赖 notifications 包，
 * 只约定入箱事实形状与幂等去重键。
 *
 * 提交后钩子（onSettled/onDead）与本 port 是两条独立通道：前者只承载
 * metrics/trace 级 best-effort 观察（可丢），可靠投递一律走本 port。
 */
import type { WalletTx } from './wallet-store.js';

/** 入箱事实（billing 视角的唯一词汇：事件名 + 载荷 + 幂等去重键） */
export interface OutboxFact {
  /** 幂等去重键（requestId 维度派生）：同键并发/重试由消费方 dedupe 后单一投递 */
  dedupeKey: string;
  /** 事件名（notifications NOTIFY_EVENTS 封闭词表成员，如 billing_dead） */
  event: string;
  payload: Record<string, unknown>;
}

export interface NotificationOutboxPort {
  /**
   * 在业务事务内写通知事实：实现必须与业务写共用同一事务连接（tx 只进不出——
   * opaque 句柄，不构成事务泄漏）。失败必须抛错（调用方事务整体回滚）；
   * 返回 false = 该 dedupeKey 已入箱（重试/重放被幂等吸收，非红灯）。
   */
  append(tx: WalletTx, fact: OutboxFact): Promise<boolean>;
}
