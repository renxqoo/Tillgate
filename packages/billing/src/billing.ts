/**
 * createBilling facade（收口装配：§3 目标态的包根出口）。
 *
 * 装配分两层：
 *   - 本文件：纯装配（store 注入——内存 stand-in 可测，应用层组合不绑 PG）；
 *   - ./composition：postgres 装配便捷件（db + retry → 全套 store → createBilling），
 *     仅 app assembly / 迁移脚本 / adapter 集成测试可引用（总纲 §5.3）。
 *
 * 支付（payments/redemption）因渠道凭证（epay key / stripe secret）是部署环境事实，
 * 不进核心 facade——app assembly 用 createPaymentsApi/createRedemptionApi 按环境组合。
 * 需要可靠通知的事件（onSettled/onDead/wake）是注入位：投递语义归 notifications。
 */
import { createWalletApi, type WalletApi, type WalletEnv } from './application/wallet/wallet.js';
import {
  createBillingApi,
  createDefaultFundingRegistry,
  type BillingApi,
  type BillingDeps,
} from './application/billing/billing.js';
import {
  createSettlementApi,
  type SettlementApi,
  type SettlementDeps,
} from './application/settlement/settlement.js';
import {
  createSubscriptionsApi,
  type SubscriptionsApi,
  type SubscriptionsEnv,
} from './application/subscriptions/subscriptions.js';
import type { WalletStore } from './ports/wallet-store.js';
import type { BillingStore } from './ports/billing-store.js';
import type {
  FundingSourceResolver,
  SubscriptionQuotaStore,
  ChannelExposureStore,
} from './ports/funding-ports.js';
import type { AccountContextStore } from './ports/account-context.js';
import type { SettleFailurePolicyConfig } from './domain/billing/settle-failure.js';

export interface CreateBillingConfig {
  /** 计费币种与钱包词表白名单（装配必填——零写死） */
  guards: WalletEnv['guards'];
  currency: string;
  /** 凭证 → 订阅绑定/开关/限额（app assembly 桥接 accounts/identity） */
  resolver: FundingSourceResolver;
  /** 结算失败策略（次数/退避必填注入） */
  failurePolicy: SettleFailurePolicyConfig;
  clock?: () => Date;
  /** signal 成功转 pending 后的结算唤醒（纯门铃；丢失由 worker 兜底扫描覆盖） */
  wake?: (requestId: string) => void;
  onSettled?: SettlementDeps['onSettled'];
  onDead?: SettlementDeps['onDead'];
}

export interface BillingStores {
  walletStore: WalletStore;
  store: BillingStore;
  quota: SubscriptionQuotaStore;
  channels?: ChannelExposureStore;
  accounts?: AccountContextStore;
}

export interface Billing {
  wallet: WalletApi;
  billing: BillingApi;
  settlement: SettlementApi;
  subscriptions: SubscriptionsApi;
}

export function createBilling(stores: BillingStores, config: CreateBillingConfig): Billing {
  const wallet = createWalletApi({
    store: stores.walletStore,
    guards: config.guards,
    currency: config.currency,
  });
  const billingDeps: BillingDeps = {
    store: stores.store,
    resolver: config.resolver,
    quota: stores.quota,
    channels: stores.channels ?? defaultChannelsUnavailable,
    walletStore: stores.walletStore,
    wallet,
    currency: config.currency,
    clock: config.clock,
    wake: config.wake,
  };
  const billing = createBillingApi(billingDeps);
  const fundingRegistry = createDefaultFundingRegistry({
    wallet,
    walletStore: stores.walletStore,
    store: stores.store,
    quota: stores.quota,
  });
  const settlement = createSettlementApi({
    store: stores.store,
    walletStore: stores.walletStore,
    fundingRegistry,
    channels: stores.channels,
    failurePolicy: config.failurePolicy,
    clock: config.clock,
    onSettled: config.onSettled,
    onDead: config.onDead,
  });
  const subscriptionsEnv: SubscriptionsEnv = {
    store: stores.store,
    accounts: stores.accounts ?? defaultAccountContextUnavailable,
    wallet,
    clock: config.clock,
  };
  return {
    wallet,
    billing,
    settlement,
    subscriptions: createSubscriptionsApi(subscriptionsEnv),
  };
}

/** 未注入渠道敞口 store 时授权链渠道闸的显式红灯（禁静默降级） */
const defaultChannelsUnavailable: ChannelExposureStore = {
  findChannel() {
    throw new Error('billing: channel exposure store not assembled (reserveChannel unavailable)');
  },
  tryIncreaseReserved() {
    throw new Error('billing: channel exposure store not assembled (reserveChannel unavailable)');
  },
  tryDecreaseReserved() {
    throw new Error('billing: channel exposure store not assembled');
  },
  deductBudgetAndMaybeBreak() {
    throw new Error('billing: channel exposure store not assembled');
  },
};

/** 未注入账户协作 port 时订阅生命周期的显式红灯（禁静默降级） */
const defaultAccountContextUnavailable: AccountContextStore = {
  userExists() {
    throw new Error('billing: accountContext store not assembled (subscriptions unavailable)');
  },
  isEnterprise() {
    throw new Error('billing: accountContext store not assembled (subscriptions unavailable)');
  },
  insertOrgWithOwner() {
    throw new Error('billing: accountContext store not assembled (subscriptions unavailable)');
  },
  rebindCredentials() {
    throw new Error('billing: accountContext store not assembled (subscriptions unavailable)');
  },
};
