/**
 * billing 用例族装配出口：authorize / signal / admission / reserveChannel 各居一文件，
 * 此处只做组合（装配参数一次注入）。资金来源注册表由装配构造（缺省 {subscription, payg}）。
 */
import { createAuthorizeUseCase, type BillingEnv } from './authorize.js';
import { createSignalUseCase } from './signal.js';
import { createBacklogAdmission, type BacklogAdmissionConfig } from './admission.js';
import { createReserveChannelUseCase } from './reserve-channel.js';
import { createFundingRegistry, type FundingRegistry } from './funding/registry.js';
import { createPaygSource } from './funding/payg-source.js';
import { createSubscriptionSource } from './funding/subscription-source.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type {
  ChannelExposureStore,
  FundingSourceResolver,
  SubscriptionQuotaStore,
} from '../../ports/funding-ports.js';
import type { WalletStore } from '../../ports/wallet-store.js';
import type { WalletApi } from '../wallet/wallet.js';

export type { BillingEnv } from './authorize.js';
export type { AuthorizeBillingInput, BillingAuthorization } from './authorize.js';
export type { BillingEvent, BillingSignalResult } from './signal.js';
export type { ReserveChannelInput, ChannelReservationResult } from './reserve-channel.js';
export type { BacklogAdmissionConfig } from './admission.js';

export interface BillingApi {
  authorize: ReturnType<typeof createAuthorizeUseCase>;
  signal: ReturnType<typeof createSignalUseCase>;
  reserveChannel: ReturnType<typeof createReserveChannelUseCase>;
}

export interface BillingDeps {
  store: BillingStore;
  resolver: FundingSourceResolver;
  quota: SubscriptionQuotaStore;
  channels: ChannelExposureStore;
  walletStore: WalletStore;
  wallet: WalletApi;
  currency: string;
  /** 时钟（装配必填——facade 单点注入向下传递） */
  clock: () => Date;
  assertCapacity?: () => Promise<void>;
  wake?: (requestId: string) => void;
}

/** 缺省来源集 = {subscription(10), payg(100)}；新来源 = 装配数组加一项，管线零改动 */
export function createDefaultFundingRegistry(deps: {
  wallet: WalletApi;
  walletStore: WalletStore;
  store: BillingStore;
  quota: SubscriptionQuotaStore;
}): FundingRegistry {
  return createFundingRegistry([
    createSubscriptionSource({
      quota: deps.quota,
      billing: deps.store,
      wallet: deps.wallet,
      walletStore: deps.walletStore,
    }),
    createPaygSource({ wallet: deps.wallet, walletStore: deps.walletStore }),
  ]);
}

export function createBillingApi(deps: BillingDeps): BillingApi {
  const env: BillingEnv = {
    store: deps.store,
    resolver: deps.resolver,
    currency: deps.currency,
    fundingRegistry: createDefaultFundingRegistry(deps),
    wallet: deps.wallet,
    clock: deps.clock,
    assertCapacity: deps.assertCapacity,
    wake: deps.wake,
  };
  return {
    authorize: createAuthorizeUseCase(env),
    signal: createSignalUseCase({ ...env, channels: deps.channels }),
    reserveChannel: createReserveChannelUseCase({
      store: deps.store,
      channels: deps.channels,
      clock: deps.clock,
    }),
  };
}

/** 积压准入（authorize 的 assertCapacity 注入件） */
export function createBillingAdmission(config: BacklogAdmissionConfig) {
  return createBacklogAdmission(config);
}
