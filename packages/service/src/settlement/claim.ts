/**
 * claim 用例：结算认领——settlement_pending/retry_wait 批量领取为 processing
 * （SKIP LOCKED 多副本安全，repo 单语句 CTE）；租约保活给长结算事务续命，
 * 防 recover 误判回收造成双扣。收据解码不在此处——毒收据在结算管线分类死信。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';

/** 结算认领（camelCase DTO——repo 行的用例形态） */
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

export interface ClaimEnv {
  db: Db;
  repos?: Repositories;
}

function toClaim(row: {
  request_id: string;
  claim_token: string;
  revision: number;
  settlement_attempts: number;
  receipt: Record<string, unknown> | null;
  trace_parent: string | null;
}): SettlementClaim {
  return {
    requestId: row.request_id,
    ownerId: '',
    claimToken: row.claim_token,
    revision: Number(row.revision),
    attempt: Number(row.settlement_attempts),
    receipt: row.receipt,
    traceParent: row.trace_parent,
  };
}

export function createClaimUseCase(env: ClaimEnv) {
  const repos = env.repos ?? createRepositories();
  return async function claim(ctx: RunContext, input: ClaimInput): Promise<SettlementClaim[]> {
    const rows = await env.db.transaction((tx) =>
      repos.billingRequest.claimPending(inTx(ctx, tx), {
        ownerId: input.ownerId,
        limit: input.batchSize,
        claimLeaseMs: input.claimLeaseMs,
        requestIds: input.requestIds,
      }),
    );
    return rows.map((row) => ({ ...toClaim(row), ownerId: input.ownerId }));
  };
}

/** 认领租约保活：长结算事务周期性续租（claim 三元组中的 until） */
export function createRenewClaimsUseCase(env: ClaimEnv) {
  const repos = env.repos ?? createRepositories();
  return async function renewClaims(
    ctx: RunContext,
    input: { ownerId: string; tokens: readonly string[]; claimLeaseMs: number },
  ): Promise<void> {
    await env.db.transaction((tx) =>
      repos.billingRequest.renewClaims(inTx(ctx, tx), input),
    );
  };
}
