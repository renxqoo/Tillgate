/**
 * signal 用例：四事件——8 态状态机的网关侧入口。
 *
 *   upstream.started   authorized → in_flight（起租约，覆盖整个请求预算）
 *   lease.renewed      in_flight 续租（owner 校验）
 *   request.succeeded  authorized/in_flight → settlement_pending
 *                     （rating.validateReceipt 验收 → CAS 落收据；竞态输家按指纹判幂等/冲突）
 *   request.failed     authorized/in_flight → released（三路预扣同事务释放：不扣）
 */
import { BillingErrors } from '../../domain/errors.js';
import { commandFingerprint } from '../../domain/fingerprint.js';
import { normalizeAmount } from '../../domain/money.js';
import { validateReceipt } from '../../domain/rating/receipt.js';
import type { BillingQuote, UsageReceipt } from '../../domain/rating/types.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import type { BillingEnv } from './authorize.js';
import { createReleaseAllReservations } from './funding/release.js';

/** failure_code 列宽（varchar(64)）的镜像——截断即审计词汇上限 */
const FAILURE_CODE_MAX = 64;

export type BillingEvent =
  | { type: 'upstream.started'; requestId: string; leaseOwner: string; leaseMs: number }
  | { type: 'lease.renewed'; requestId: string; leaseOwner: string; leaseMs: number }
  | { type: 'request.succeeded'; requestId: string; receipt: UsageReceipt }
  | { type: 'request.failed'; requestId: string; reason: string };

export interface BillingSignalResult {
  changed: boolean;
  status: string;
  replayed: boolean;
  /** request.failed 实际释放的预扣金额（未扣费证据） */
  amountReleased?: string;
}

export function createSignalUseCase(env: BillingEnv & { channels?: ChannelExposureStore }) {
  const { store, clock = () => new Date() } = env;

  const releaseAllReservations = createReleaseAllReservations({
    registry: env.fundingRegistry,
    channels: env.channels,
    store: env.store,
  });

  async function current(requestId: string): Promise<string> {
    const status = await store.read((conn) => store.currentStatus(conn, requestId));
    if (!status) {
      throw BillingErrors.business('state_conflict', {
        requestId,
        detail: 'billing request missing',
      });
    }
    return status;
  }

  return async function signal(event: BillingEvent): Promise<BillingSignalResult> {
    switch (event.type) {
      case 'upstream.started': {
        const now = clock();
        const changed = await store.transaction((tx) =>
          store.casUpstreamStarted(tx, {
            requestId: event.requestId,
            leaseOwner: event.leaseOwner,
            leaseExpiresAt: new Date(now.getTime() + event.leaseMs),
          }),
        );
        if (changed) return { changed: true, status: 'in_flight', replayed: false };
        return { changed: false, status: await current(event.requestId), replayed: true };
      }

      case 'lease.renewed': {
        const now = clock();
        const changed = await store.transaction((tx) =>
          store.casTransition(tx, {
            requestId: event.requestId,
            from: ['in_flight'],
            to: 'in_flight',
            set: {
              leaseExpiresAt: new Date(now.getTime() + event.leaseMs),
              leaseOwner: event.leaseOwner,
            },
          }),
        );
        if (changed) return { changed: true, status: 'in_flight', replayed: false };
        return { changed: false, status: await current(event.requestId), replayed: true };
      }

      case 'request.succeeded': {
        if (event.receipt.requestId !== event.requestId) {
          throw BillingErrors.business('state_conflict', {
            requestId: event.requestId,
            detail: 'receipt requestId mismatch',
          });
        }
        const now = clock();
        const receiptFp = commandFingerprint(
          'billing.receipt',
          event.receipt as unknown as Record<
            string,
            import('../../domain/fingerprint.js').FingerprintValue
          >,
        );
        const authorized = await store.read((conn) => store.findByRequestId(conn, event.requestId));
        if (!authorized) {
          throw BillingErrors.business('state_conflict', {
            requestId: event.requestId,
            detail: 'billing request missing',
          });
        }
        if (
          ['settlement_pending', 'settled'].includes(authorized.status) &&
          authorized.receiptFingerprint === receiptFp
        ) {
          return { changed: false, status: authorized.status, replayed: true };
        }
        if (!['authorized', 'in_flight'].includes(authorized.status)) {
          throw BillingErrors.business('state_conflict', {
            requestId: event.requestId,
            detail: 'receipt conflicts with billing state',
          });
        }
        validateReceipt(
          authorized.userId,
          authorized.quote as unknown as BillingQuote,
          event.receipt,
        );
        const changed = await store.transaction((tx) =>
          store.casTransition(tx, {
            requestId: event.requestId,
            from: ['authorized', 'in_flight'],
            to: 'settlement_pending',
            set: {
              receipt: event.receipt as unknown as Record<string, unknown>,
              receiptFingerprint: receiptFp,
              leaseExpiresAt: null,
              nextSettlementAt: now,
              lastError: null,
            },
          }),
        );
        if (changed) {
          // 事件唤醒（纯门铃：失败不重试不阻断；丢失由 worker 兜底扫描覆盖）
          env.wake?.(event.requestId);
          return { changed: true, status: 'settlement_pending', replayed: false };
        }
        // 条件更新竞态失败：同指纹仍幂等，异指纹才是真冲突
        const existing = await store.read((conn) => store.findByRequestId(conn, event.requestId));
        if (
          existing &&
          ['settlement_pending', 'settled'].includes(existing.status) &&
          existing.receiptFingerprint === receiptFp
        ) {
          return { changed: false, status: existing.status, replayed: true };
        }
        throw BillingErrors.business('state_conflict', {
          requestId: event.requestId,
          detail: 'receipt conflicts with billing state',
        });
      }

      case 'request.failed': {
        const now = clock();
        const released = await store.transaction(async (tx) => {
          const row = await store.casTransition(tx, {
            requestId: event.requestId,
            from: ['authorized', 'in_flight'],
            to: 'released',
            set: {
              failureCode: event.reason.slice(0, FAILURE_CODE_MAX),
              leaseExpiresAt: null,
              releasedAt: now,
            },
          });
          if (!row) return null;
          const full = await store.findByRequestId(tx, event.requestId);
          if (!full) {
            throw BillingErrors.business('state_conflict', {
              requestId: event.requestId,
              detail: 'billing row missing after release',
            });
          }
          await releaseAllReservations(tx, {
            requestId: event.requestId,
            reservedAmount: full.reservedAmount,
            channelId: full.channelId,
            channelReservedAmount: full.channelReservedAmount,
            now,
          });
          return normalizeAmount(full.reservedAmount);
        });
        if (released != null) {
          return { changed: true, status: 'released', replayed: false, amountReleased: released };
        }
        return { changed: false, status: await current(event.requestId), replayed: true };
      }
    }
  };
}
