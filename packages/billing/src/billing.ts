/**
 * createBilling facade（收口装配的包根出口）。
 *
 * 装配分两层：
 *   - 本文件：纯装配（store 注入——内存 stand-in 可测，应用层组合不绑 PG）；
 *   - ./composition：postgres 装配便捷件（db + retry → 全套 store → createBilling），
 *     仅 app assembly / 迁移脚本 / adapter 集成测试可引用。
 *
 * 支付（payments/redemption）因渠道凭证（epay key / stripe secret）是部署环境事实，
 * 不进核心 facade——app assembly 用 createPaymentsApi/createRedemptionApi 按环境组合。
 * 可靠通知走 NotificationOutboxPort：结算/死信事实在业务事务提交前同事务入箱
 * （入箱失败回滚）；onSettled/onDead/wake 是提交后的 metrics 级 best-effort
 * 观察钩子（可丢），不承载资金、安全、恢复所需事实。
 */
import { DefectError } from '@tillgate/errors';
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
import { listPlans, type ListPlansQuery } from './application/plans/list-plans.js';
import { createPlan, type CreatePlanInput } from './application/plans/create-plan.js';
import { updatePlan, type UpdatePlanInput } from './application/plans/update-plan.js';
import { deletePlan } from './application/plans/delete-plan.js';
import type { PlanRecord } from './ports/billing-store.js';
import type { WalletStore } from './ports/wallet-store.js';
import type { BillingStore } from './ports/billing-store.js';
import type {
  FundingSourceResolver,
  SubscriptionQuotaStore,
  ChannelExposureStore,
} from './ports/funding-ports.js';
import type { NotificationOutboxPort } from './ports/notification-outbox.js';
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
  /**
   * 时钟（装配必填单点注入，向下传递到全部用例——零隐藏缺省；
   * 钱包动词内部的 DB 时钟权威路径不经此）
   */
  clock: () => Date;
  /**
   * 可靠通知事务参与 port：结算/死信事实同事务入箱，入箱失败回滚
   * 业务事务。消费方 = app assembly 桥接 notifications outbox。
   */
  outbox?: NotificationOutboxPort;
  /**
   * recover 毒行隔离写入（装配必填：logger/遥测注入；单行归还失败留痕不中断整批）。
   */
  onError: SettlementDeps['onError'];
  /** signal 成功转 pending 后的结算唤醒（纯门铃；丢失由 worker 兜底扫描覆盖） */
  wake?: (requestId: string) => void;
  onSettled?: SettlementDeps['onSettled'];
  onDead?: SettlementDeps['onDead'];
  /** 死信复核同事务审计 port（app 装配桥 observability writeAudit;缺省丢弃） */
  reviewAuditTx?: SettlementDeps['reviewAuditTx'];
}

export interface BillingStores {
  walletStore: WalletStore;
  store: BillingStore;
  quota: SubscriptionQuotaStore;
  channels?: ChannelExposureStore;
  accounts?: AccountContextStore;
}

/** 套餐目录管理组（admin-api 消费;审计后置归 app 装配层） */
export interface PlansApi {
  list(query: ListPlansQuery): Promise<{ rows: PlanRecord[]; total: number }>;
  create(input: CreatePlanInput): Promise<PlanRecord>;
  update(input: UpdatePlanInput): Promise<PlanRecord>;
  remove(input: { planId: number }): Promise<{ ok: true }>;
}

export interface Billing {
  wallet: WalletApi;
  billing: BillingApi;
  settlement: SettlementApi;
  subscriptions: SubscriptionsApi;
  plans: PlansApi;
}

// eslint-disable-next-line max-lines-per-function -- billing 装配根:DI 接线顺序即契约
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
    outbox: config.outbox,
    onError: config.onError,
    onSettled: config.onSettled,
    onDead: config.onDead,
    ...(config.reviewAuditTx !== undefined ? { reviewAuditTx: config.reviewAuditTx } : {}),
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
    plans: {
      list: (query) => listPlans({ store: stores.store }, query),
      create: (input) => createPlan({ store: stores.store }, input),
      update: (input) => updatePlan({ store: stores.store }, input),
      remove: (input) => deletePlan({ store: stores.store }, input),
    },
  };
}

/** 未注入渠道敞口 store 时授权链渠道闸的显式红灯（禁静默降级） */
const defaultChannelsUnavailable: ChannelExposureStore = {
  findChannel() {
    throw new DefectError(
      'channel exposure store not assembled (reserveChannel unavailable)',
      'billing.channel_exposure_unassembled',
    );
  },
  tryIncreaseReserved() {
    throw new DefectError(
      'channel exposure store not assembled (reserveChannel unavailable)',
      'billing.channel_exposure_unassembled',
    );
  },
  tryDecreaseReserved() {
    throw new DefectError(
      'channel exposure store not assembled',
      'billing.channel_exposure_unassembled',
    );
  },
  deductBudgetAndMaybeBreak() {
    throw new DefectError(
      'channel exposure store not assembled',
      'billing.channel_exposure_unassembled',
    );
  },
};

/** 未注入账户协作 port 时订阅生命周期的显式红灯（禁静默降级） */
const defaultAccountContextUnavailable: AccountContextStore = {
  userExists() {
    throw new DefectError(
      'accountContext store not assembled (subscriptions unavailable)',
      'billing.account_context_unassembled',
    );
  },
  isEnterprise() {
    throw new DefectError(
      'accountContext store not assembled (subscriptions unavailable)',
      'billing.account_context_unassembled',
    );
  },
  insertOrgWithOwner() {
    throw new DefectError(
      'accountContext store not assembled (subscriptions unavailable)',
      'billing.account_context_unassembled',
    );
  },
  rebindCredentials() {
    throw new DefectError(
      'accountContext store not assembled (subscriptions unavailable)',
      'billing.account_context_unassembled',
    );
  },
};
