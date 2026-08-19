/**
 * settlement 装配出口：claim（认领+保活）/ settleClaim（结算）/ processClaim（管线壳）/
 * finishFailure（失败处置）/ recover（滞留兜底）——worker-v2 的全部资金用例。
 * repo 原语（SKIP LOCKED / CAS）与 domain 规则（分配/失败策略/解码）均已就位，
 * 本域只做事务编排。
 */
import { BILLING_REF_TYPE, type SettleFailurePolicyConfig } from '@ai-gateway/domain';
import type { Db } from '@ai-gateway/repository';
import type { Repositories } from '@ai-gateway/repository';
import { createChannelBudgetUseCases, type ChannelBudgetCloseout } from '../channel-budget/index.js';
import { createDefaultFundingRegistry } from '../funding/index.js';
import type { FundingRegistry } from '../funding/registry.js';
import { createWallet, type WalletApi } from '../wallet/wallet.js';
import { REVENUE_ACCOUNT } from '@ai-gateway/domain';
import { createClaimUseCase, createRenewClaimsUseCase } from './claim.js';
import { createFailureUseCase } from './failure.js';
import { createProcessClaimUseCase } from './process.js';
import { createRecoverUseCase } from './recover.js';
import { createSettleClaimUseCase } from './settle.js';

export type { SettlementClaim, ClaimInput } from './claim.js';
export type { FailureOutcome } from './failure.js';
export type { ClaimOutcome } from './process.js';
export type { RecoveryRunResult } from './recover.js';
export type { SettleClaimResult } from './settle.js';

export interface SettlementDomainDeps {
  db: Db;
  /** 计费币种（默认钱包与来源集装配用） */
  currency: string;
  wallet?: WalletApi;
  fundingRegistry?: FundingRegistry;
  channelBudget?: ChannelBudgetCloseout;
  clock?: () => Date;
  repos?: Repositories;
  /** 失败处置策略（装配必填——最大尝试次数/退避参数不写死） */
  policy: SettleFailurePolicyConfig;
}

export function createSettlementDomain(deps: SettlementDomainDeps) {
  const wallet =
    deps.wallet ??
    createWallet({
      db: deps.db,
      currency: deps.currency,
      guards: {
        refTypes: [BILLING_REF_TYPE],
        currencies: [deps.currency],
        internalAccounts: [REVENUE_ACCOUNT],
      },
    });
  const fundingRegistry =
    deps.fundingRegistry ?? createDefaultFundingRegistry({ wallet, repos: deps.repos });
  const channelBudget =
    deps.channelBudget ?? createChannelBudgetUseCases({ db: deps.db, clock: deps.clock, repos: deps.repos });
  const env = {
    db: deps.db,
    fundingRegistry,
    channelBudget,
    clock: deps.clock,
    repos: deps.repos,
  };
  const settleClaim = createSettleClaimUseCase(env);
  const finishFailure = createFailureUseCase({ db: deps.db, policy: deps.policy, repos: deps.repos });
  return {
    claim: createClaimUseCase({ db: deps.db, repos: deps.repos }),
    renewClaims: createRenewClaimsUseCase({ db: deps.db, repos: deps.repos }),
    settleClaim,
    processClaim: createProcessClaimUseCase({ settleClaim, finishFailure }),
    finishFailure,
    recover: createRecoverUseCase(env),
  };
}

export type SettlementDomain = ReturnType<typeof createSettlementDomain>;
