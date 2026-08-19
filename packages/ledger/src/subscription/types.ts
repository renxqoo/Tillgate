/** subscription 域契约类型（S3）。资金动作全部委托 wallet，域内零余额读写。 */
import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import type { DomainOperations } from '../platform/operations.js';

/** 域操作 kinds 白名单（ledger-core fail-closed；新增动词先登记此处） */
export const SUBSCRIPTION_OPERATION_KINDS = [
  'subscription.purchase',
  'subscription.renew',
  'subscription.change',
  'subscription.cancel',
  'pack.grant',
] as const;

export interface SubscriptionEffects {
  /** 尽力而为审计（提交后观测失败不改变已提交结果） */
  audit?(event: {
    adminId?: number | null;
    action: string;
    targetType: string;
    targetId?: number | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void>;
}

export interface SubscriptionDeps {
  /** 业务表（plans/user_subscriptions/org 等） */
  db: Db;
  /** 资金动作：refTypes 白名单须含 'subscription' 与 'pack' */
  wallet: Wallet;
  effects?: SubscriptionEffects;
  /** 缺省系统时钟；测试可注入确定性时钟 */
  clock?: () => Date;
}

/** 动词执行上下文（装配层构建；verbs 一文件一动词） */
export interface SubscriptionContext {
  db: Db;
  wallet: Wallet;
  operations: DomainOperations;
  effects?: SubscriptionEffects;
  clock: () => Date;
}

export interface PurchaseInput {
  operationId: string;
  userId: number;
  planId: number;
  /** 席位（共享额度池：总额度 = 档额度 × 席位）；缺省 1 */
  quantity?: number;
  orgId?: number | null;
  /** 团队套餐购买时在事务内复用/创建组织（org 与订阅同生共死） */
  ensureOrg?: boolean;
  adminId?: number | null;
}

export interface RenewInput {
  operationId: string;
  /** 自助续费校验归属；管理端续费传 null */
  userId?: number | null;
  subscriptionId: number;
  adminId?: number | null;
}

export interface ChangeInput {
  operationId: string;
  userId?: number | null;
  adminId?: number | null;
  subscriptionId: number;
  targetPlanId: number;
  quantity: number;
}

export interface CancelInput {
  operationId: string;
  subscriptionId: number;
  adminId?: number | null;
}

export interface PackInput {
  operationId: string;
  userId: number;
  packId: number;
  adminId?: number | null;
}

/** 购买/续费/变更/加油包共用回执（幂等重放返回首次存档） */
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
  /** 资金流水余额快照；未发生资金变动（免费升级）为 null——真实余额以 wallet 为准 */
  balanceBefore: string | null;
  balanceAfter: string | null;
  replayed: boolean;
}

export interface CancelResult {
  subscriptionId: number;
  replayed: boolean;
}

export interface SubscriptionDomain {
  purchase(input: PurchaseInput): Promise<SubscribeResult>;
  renew(input: RenewInput): Promise<SubscribeResult>;
  change(input: ChangeInput): Promise<SubscribeResult>;
  cancel(input: CancelInput): Promise<CancelResult>;
  grantPack(input: PackInput): Promise<SubscribeResult>;
}
