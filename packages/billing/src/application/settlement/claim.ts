/**
 * claim 用例：结算认领——settlement_pending/retry_wait 批量领取为 processing
 * （SKIP LOCKED 多副本安全，store 单语句 CTE）；租约保活给长结算事务续命，
 * 防 recover 误判回收造成双扣。收据解码不在此处——毒收据在结算管线分类死信。
 */
import type { BillingStore } from '../../ports/billing-store.js';

/** 结算认领（认领五元组的用例形态） */
export interface SettlementClaim {
  requestId: string;
  ownerId: string;
  claimToken: string;
  /** 乐观锁版本（认领时快照，结算 CAS 五元组之一） */
  revision: number;
  /** 含本次的已尝试次数（失败策略输入） */
  attempt: number;
  receipt: Record<string, unknown> | null;
  traceParent: string | null;
}

export interface ClaimInput {
  ownerId: string;
  batchSize: number;
  claimLeaseMs: number;
  requestIds?: readonly string[];
}

export function createClaimUseCase(env: { store: BillingStore }) {
  const { store } = env;
  return async function claim(input: ClaimInput): Promise<SettlementClaim[]> {
    const rows = await store.transaction((tx) => store.claimPending(tx, input));
    return rows.map((row) => ({ ...row, ownerId: input.ownerId }));
  };
}

/** 认领租约保活：长结算事务周期性续租 */
export function createRenewClaimsUseCase(env: { store: BillingStore }) {
  const { store } = env;
  return async function renewClaims(input: {
    ownerId: string;
    tokens: readonly string[];
    claimLeaseMs: number;
  }): Promise<void> {
    await store.transaction((tx) => store.renewClaims(tx, input));
  };
}
