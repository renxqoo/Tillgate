/**
 * billing 域装配出口（网关侧最小集）：authorize（预扣）/ signal（四事件）/
 * reserveChannel（渠道敞口预留）——推理管线的三个资金触点。
 * settleClaim / review（死单复核）分别是 worker / admin-api 的用例——
 * 角色裁剪 2026-08-19 移出；signal(request.succeeded) 终态仍是 settlement_pending，
 * 结算由 worker 消费该状态。
 */
import type { Db } from '@ai-gateway/repository';
import type { Repositories } from '@ai-gateway/repository';
import { BILLING_REF_TYPE } from '@ai-gateway/domain';
import { createWallet, type WalletApi } from '../wallet/wallet.js';
import { REVENUE_ACCOUNT } from '@ai-gateway/domain';
import { createChannelBudgetUseCases } from '../channel-budget/index.js';
import { createDefaultFundingRegistry, type FundingRegistry } from '../funding/index.js';
import { createAuthorizeUseCase } from './authorize.js';
import { createSignalUseCase } from './signal.js';
import { createReserveChannelUseCase } from './reserve-channel.js';

export type { AuthorizeBillingInput, BillingAuthorization } from './authorize.js';
export type { BillingEvent, BillingSignalResult } from './signal.js';

/** 结算唤醒队列名（gateway 生产端与 worker 消费端的共同契约；消息纯门铃不带账务） */
/** 结算唤醒 PG NOTIFY 通道名（生产/消费单一真相） */
export const SETTLE_WAKE_CHANNEL = 'settle-wake';
export type { ReserveChannelInput, ChannelReservationResult } from './reserve-channel.js';
export { createBacklogAdmission, type BacklogAdmissionConfig } from './admission.js';

export interface BillingDomainDeps {
  db: Db;
  /** 计费币种（装配必填——流入钱包白名单与资金规划的口径，不藏全局默认） */
  currency: string;
  /** 资金动作：refTypes 白名单须含 'billing'；缺省自建（含 'billing'） */
  wallet?: WalletApi;
  /** 资金来源注册表（缺省 {subscription, payg}；测试可注入定制来源集） */
  fundingRegistry?: FundingRegistry;
  /** 结算唤醒端口（signal → settlement_pending 后调用；装配层注入事件通道，如 PG NOTIFY 生产端） */
  wake?: (requestId: string) => void;
  clock?: () => Date;
  /** 结算积压准入（可选；抛 BillingBacklogError 关闸） */
  admission?: { assertCapacity(): Promise<void> };
  /** 仓储注入（缺省进程级默认实例） */
  repos?: Repositories;
}

export function createBillingDomain(deps: BillingDomainDeps) {
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
  const env = {
    db: deps.db,
    wallet,
    fundingRegistry,
    currency: deps.currency,
    clock: deps.clock,
    assertCapacity: deps.admission?.assertCapacity,
    wake: deps.wake,
    repos: deps.repos,
  };
  const channelBudget = createChannelBudgetUseCases({ db: deps.db, clock: deps.clock, repos: deps.repos });
  return {
    authorize: createAuthorizeUseCase(env),
    signal: createSignalUseCase({ ...env, channelBudget }),
    reserveChannel: createReserveChannelUseCase(env),
  };
}

export type BillingDomain = ReturnType<typeof createBillingDomain>;
