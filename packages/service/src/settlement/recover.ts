/**
 * recover 用例：三类滞留单兜底（网关/worker 崩溃后的资金安全网）。
 *
 *   ① authorized 过期且从未发上游 → released（授权未动余额，只还预占）
 *   ② in_flight 租约过期（网关崩溃）→ released（释放不扣，2026-08-17 政策）
 *   ③ processing 认领租约过期（worker 崩溃）→ retry_wait 立即可重领
 *
 * ①②的预占归还走 funding/release 的明细逐笔路径（与 signal(failed) 同一实现）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { ChannelBudgetCloseout } from '../channel-budget/index.js';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import { createReleaseAllReservations } from '../funding/release.js';
import type { FundingRegistry } from '../funding/registry.js';

export interface RecoverEnv {
  db: Db;
  fundingRegistry: FundingRegistry;
  channelBudget?: ChannelBudgetCloseout;
  clock?: () => Date;
  repos?: Repositories;
  /** 单行归还失败只记日志不中断整批（默认 console.error） */
  onError?: (error: unknown, context: string) => void;
}

export interface RecoveryRunResult {
  released: number;
  claimsRequeued: number;
}

export function createRecoverUseCase(env: RecoverEnv) {
  const { db, clock = () => new Date() } = env;
  const repos = env.repos ?? createRepositories();
  const releaseAllReservations = createReleaseAllReservations({
    registry: env.fundingRegistry,
    channelBudget: env.channelBudget,
    repos,
  });

  /**
   * 单路径（逐单事务，毒行隔离）：无锁列候选 → 逐单事务「CAS 迁移 released +
   * 明细归还」。单行投影异常（归还路径抛错）只损失该行——批量单事务形态下
   * 毒行按 lease_expires_at 排序永远队头，整批滞留单的预占全部冻结。
   * 毒行自身每轮重试，直至人工介入（dead-release 审计面）。
   */
  async function releaseExpired(
    ctx: RunContext,
    input: { status: 'authorized' | 'in_flight'; limit: number; failureCode: string },
    onError?: (error: unknown, context: string) => void,
  ): Promise<number> {
    const candidates = await repos.billingRequest.listExpiredForRecovery(
      { ...ctx, db },
      { status: input.status, limit: input.limit },
    );
    let released = 0;
    for (const requestId of candidates) {
      try {
        released += await db.transaction(async (tx): Promise<number> => {
          const c = inTx(ctx, tx);
          const row = await repos.billingRequest.recoverOneToReleased(c, {
            requestId,
            status: input.status,
            failureCode: input.failureCode,
          });
          if (!row) return 0;
          await releaseAllReservations(ctx, tx, {
            requestId: row.request_id,
            reservedAmount: row.reserved_amount,
            channelId: row.channel_id,
            channelReservedAmount: row.channel_reserved_amount,
            now: clock(),
          });
          return 1;
        });
      } catch (error) {
        onError?.(error, `recover release request=${requestId}`);
      }
    }
    return released;
  }

  return async function recover(
    ctx: RunContext,
    input: { batchSize: number },
  ): Promise<RecoveryRunResult> {
    const noteError =
      env.onError ?? ((error: unknown, context: string) => console.error(`[recover] ${context}:`, error));
    const expired = await releaseExpired(ctx, {
      status: 'authorized',
      limit: input.batchSize,
      failureCode: 'authorization_expired_before_dispatch',
    }, noteError);
    const crashed = await releaseExpired(ctx, {
      status: 'in_flight',
      limit: input.batchSize,
      failureCode: 'gateway_crash_released',
    }, noteError);
    const claimsRequeued = await repos.billingRequest.requeueExpiredClaims(
      { ...ctx, db },
      input.batchSize,
    );
    return { released: expired + crashed, claimsRequeued };
  };
}
