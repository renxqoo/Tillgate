/**
 * recover 用例：三类滞留单兜底（网关/worker 崩溃后的资金安全网）。
 *
 *   ① authorized 过期且从未发上游 → released（授权未动余额，只还预占）
 *   ② in_flight 租约过期（网关崩溃）→ released（释放不扣）
 *   ③ processing 认领租约过期（worker 崩溃）→ retry_wait 立即可重领
 *
 * ①②的预占归还走 funding/release 的明细逐笔路径（与 signal(failed) 同一实现）。
 * 逐单事务毒行隔离：单行归还失败只损失该行，不阻塞整批。
 */
import type { BillingStore } from '../../ports/billing-store.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import { createReleaseAllReservations } from '../billing/funding/release.js';
import type { FundingRegistry } from '../billing/funding/registry.js';

export interface RecoverEnv {
  store: BillingStore;
  fundingRegistry: FundingRegistry;
  channels?: ChannelExposureStore;
  /** 时钟（装配必填——零写死） */
  clock: () => Date;
  /** 单行归还失败写入（装配必填：logger/遥测注入；异常不中断整批） */
  onError: (error: unknown, context: string) => void;
}

export interface RecoveryRunResult {
  released: number;
  claimsRequeued: number;
}

// eslint-disable-next-line max-lines-per-function -- 对账恢复事务体:顺序探查各状态分支
export function createRecoverUseCase(env: RecoverEnv) {
  const { store, clock } = env;
  const releaseAllReservations = createReleaseAllReservations({
    registry: env.fundingRegistry,
    channels: env.channels,
    store: env.store,
  });

  async function releaseExpired(
    input: { status: 'authorized' | 'in_flight'; limit: number; failureCode: string },
    onError?: (error: unknown, context: string) => void,
  ): Promise<number> {
    const candidates = await store.read((conn) =>
      store.listExpiredForRecovery(conn, { status: input.status, limit: input.limit }),
    );
    let released = 0;
    for (const requestId of candidates) {
      try {
        released += await store.transaction(async (tx): Promise<number> => {
          const row = await store.recoverOneToReleased(tx, {
            requestId,
            status: input.status,
            failureCode: input.failureCode,
          });
          if (!row) return 0;
          await releaseAllReservations(tx, {
            requestId: row.requestId,
            reservedAmount: row.reservedAmount,
            channelId: row.channelId,
            channelReservedAmount: row.channelReservedAmount,
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

  return async function recover(input: { batchSize: number }): Promise<RecoveryRunResult> {
    // 装配必填注入：毒行隔离的写入通道（console 直写是隐藏 I/O）
    const noteError = env.onError;
    const expired = await releaseExpired(
      {
        status: 'authorized',
        limit: input.batchSize,
        failureCode: 'authorization_expired_before_dispatch',
      },
      noteError,
    );
    const crashed = await releaseExpired(
      { status: 'in_flight', limit: input.batchSize, failureCode: 'gateway_crash_released' },
      noteError,
    );
    const claimsRequeued = await store.transaction((tx) =>
      store.requeueExpiredClaims(tx, input.batchSize),
    );
    return { released: expired + crashed, claimsRequeued };
  };
}

/** 优雅停机：本副本持有的 processing 归还 retry_wait（worker 生命周期收口用） */
export function createAbandonClaimsUseCase(env: { store: BillingStore; clock: () => Date }) {
  const { store, clock } = env;
  return async function abandonOwnedClaims(ownerId: string): Promise<number> {
    return store.transaction((tx) => store.abandonOwnedClaims(tx, ownerId, clock()));
  };
}
