/**
 * 积压准入工厂：结算堆积过深/过老时关闭新请求（结算系统自我保护——
 * 与「上游 5xx 降级」互补的资损防线）。阈值装配必填，不写死；零堆积零开销。
 */
import { BillingBacklogError } from '@ai-gateway/domain';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { readOnly, systemContext } from '../context.js';

export interface BacklogAdmissionConfig {
  db: Db;
  /** 待结算（settlement_pending + retry_wait）张数上限 */
  maxPending: number;
  /** 最老待结算账龄上限（ms） */
  maxOldestPendingMs: number;
  repos?: Repositories;
  clock?: () => Date;
}

export function createBacklogAdmission(config: BacklogAdmissionConfig) {
  const repos = config.repos ?? createRepositories();
  const clock = config.clock ?? (() => new Date());
  return async function assertCapacity(): Promise<void> {
    const inventory = await repos.billingRequest.inventory(
      readOnly(systemContext('billing-admission'), config.db),
      clock(),
    );
    const pending = inventory.pending + inventory.retrying;
    if (pending === 0) return;
    if (pending > config.maxPending || inventory.oldestPendingMs > config.maxOldestPendingMs) {
      throw new BillingBacklogError(pending, Math.round(inventory.oldestPendingMs));
    }
  };
}
