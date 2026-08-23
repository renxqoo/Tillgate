/**
 * 积压准入工厂：结算堆积过深/过老时关闭新请求（结算系统自我保护——
 * 与「上游 5xx 降级」互补的资损防线）。阈值装配必填，不写死；零堆积零开销。
 */
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';

export interface BacklogAdmissionConfig {
  store: BillingStore;
  /** 待结算（settlement_pending + retry_wait）张数上限 */
  maxPending: number;
  /** 最老待结算账龄上限（ms） */
  maxOldestPendingMs: number;
  /** 时钟（装配必填——零写死） */
  clock: () => Date;
}

export function createBacklogAdmission(config: BacklogAdmissionConfig) {
  const clock = config.clock;
  return async function assertCapacity(): Promise<void> {
    const inventory = await config.store.read((conn) => config.store.inventory(conn, clock()));
    const pending = inventory.pending + inventory.retrying;
    if (pending === 0) return;
    if (pending > config.maxPending || inventory.oldestPendingMs > config.maxOldestPendingMs) {
      throw BillingErrors.business('settlement_backlog', {
        pending,
        // 拒绝上下文携带账龄（ms，浮点原值——非账本金额，不做取整）
        oldestPendingMs: inventory.oldestPendingMs,
      });
    }
  };
}
