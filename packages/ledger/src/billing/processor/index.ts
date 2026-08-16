import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/db';
import type {
  BillingEffects,
  BillingInventory,
  RecoveryRunResult,
  SettlementProcessorOptions,
  SettlementRunResult,
} from '../types.js';
import { runOnce } from './run-once.js';
import { recoverOnce } from './recover.js';
import { abandonOwnedClaims, inventory } from './inventory.js';

export interface BillingProcessor {
  runOnce(requestIds?: string[]): Promise<SettlementRunResult>;
  recoverOnce(): Promise<RecoveryRunResult>;
  inventory(): Promise<BillingInventory>;
  abandonOwnedClaims(): Promise<number>;
}

export interface BillingProcessorDeps {
  db: Db;
  options: SettlementProcessorOptions;
  effects?: BillingEffects;
  clock?: () => Date;
  random?: () => number;
}

/**
 * 多副本安全的结算处理器（纯装配，对外唯一入口，worker 消费）。
 * 所有业务重试状态都在 PostgreSQL；BullMQ 只负责 kick。
 *
 *   runOnce            → run-once.ts（claim → 租约保活 → 逐单管线 → 计数）
 *   recoverOnce        → recover.ts（authorized 过期 / 网关崩溃 / 认领过期三类恢复）
 *   inventory          → inventory.ts（积压库存，健康检查用）
 *   abandonOwnedClaims → inventory.ts（优雅停机归还认领）
 */
export function createBillingProcessor({
  db,
  options,
  effects,
  clock = () => new Date(),
  random = Math.random,
}: BillingProcessorDeps): BillingProcessor {
  return {
    runOnce: (requestIds) => runOnce(db, options, effects, clock, random, requestIds),
    recoverOnce: () => recoverOnce(db, options),
    inventory: () => inventory(db, clock),
    abandonOwnedClaims: () => abandonOwnedClaims(db, options, clock),
  };
}

export function newProcessorOwnerId(prefix = 'billing-worker'): string {
  return `${prefix}:${randomUUID()}`;
}
