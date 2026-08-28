/**
 * 订阅生命周期用例族装配出口（资金走 wallet 复式账本）：
 *   purchase：余额现金购买（禁透支）→ 订阅行（团队套餐组织同事务创建）
 *   renew   ：顺延续费（旧订阅 CAS 转到期 + 新行 + 凭证改绑）
 *   change  ：升档/加席位（行锁新鲜快照折算 → 补差价 max(0, 新总价−剩余价值)）
 *   cancel  ：CAS 0→2，无资金变动——剩余额度作废（不退款）
 *   grantPack：有效订阅加额（现金口径 transfer，禁透支）
 * 幂等：operations 用例（operationId + 指纹——同键同参重放回执，异参 409）。
 * 资金：wallet.transfer(user → platform_revenue, allowCredit:false, 同事务)。
 * 竞态：「单有效订阅」部分唯一索引兜底 → already_subscribed（事务回滚可安全重试）。
 * adminList：管理面列表——users/plans 富化在 store 物理层。
 * 动词各居一文件（purchase/renew/change/cancel/grant-pack），此处只做类型定义与组合
 * （装配参数一次注入共享装配对象——一动词一文件）。
 */
import { adminListSubscriptions } from './admin-list-subscriptions.js';
import { purchase } from './purchase.js';
import { renew } from './renew.js';
import { change } from './change.js';
import { cancel } from './cancel.js';
import { grantPack } from './grant-pack.js';
import { createSubscriptionAssembly } from './subscription-shared.js';
import type { AdminListSubscriptionsInput } from './admin-list-subscriptions.js';
import type { AdminSubscriptionRow } from '../../ports/billing-store.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { AccountContextStore } from '../../ports/account-context.js';
import type { WalletApi } from '../wallet/wallet.js';

export interface SubscriptionsEnv {
  store: BillingStore;
  accounts: AccountContextStore;
  /** 资金动词（本域只花 transfer：现金收款） */
  wallet: Pick<WalletApi, 'transfer'>;
  /** 时钟（装配必填——facade 单点注入向下传递） */
  clock: () => Date;
}

export interface SubscribeResult {
  userId: number;
  subscriptionId: number;
  orgId: number | null;
  planId: number;
  planName: string;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  price: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  replayed: boolean;
}

export interface PurchaseInput {
  operationId: string;
  userId: number;
  planId: number;
  quantity?: number;
  /** 团队套餐：组织在购买事务内创建（与订阅共生死——预建会留孤儿 org） */
  ensureOrg?: boolean;
}

export interface RenewInput {
  operationId: string;
  /** null = 管理面（按 subscriptionId 直续，免属主检查） */
  userId: number | null;
  subscriptionId: number;
}

export interface ChangeInput {
  operationId: string;
  /** null = 管理面（免属主检查；指纹仍含发起者防跨键重放） */
  userId: number | null;
  subscriptionId: number;
  targetPlanId: number;
  quantity: number;
}

export interface CancelInput {
  operationId: string;
  subscriptionId: number;
}

export interface GrantPackInput {
  operationId: string;
  userId: number;
  packId: number;
}

export interface GrantPackResult {
  userId: number;
  subscriptionId: number;
  quotaAdded: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export interface SubscriptionsApi {
  /** 管理面列表（users/plans 富化与剩余额度投影在 store 物理层） */
  adminList(
    input: AdminListSubscriptionsInput,
  ): Promise<{ rows: AdminSubscriptionRow[]; total: number }>;
  purchase(input: PurchaseInput): Promise<SubscribeResult>;
  renew(input: RenewInput): Promise<SubscribeResult>;
  change(input: ChangeInput): Promise<SubscribeResult>;
  cancel(input: CancelInput): Promise<{ subscriptionId: number; replayed: boolean }>;
  grantPack(input: GrantPackInput): Promise<GrantPackResult>;
}

export function createSubscriptionsApi(env: SubscriptionsEnv): SubscriptionsApi {
  const assembly = createSubscriptionAssembly(env);
  return {
    adminList: (input) => adminListSubscriptions({ store: env.store }, input),
    purchase: (input) => purchase(assembly, input),
    renew: (input) => renew(assembly, input),
    change: (input) => change(assembly, input),
    cancel: (input) => cancel(assembly, input),
    grantPack: (input) => grantPack(assembly, input),
  };
}
