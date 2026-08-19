/** channel-budget 域契约类型（S4）。运营资金自治域：不进 wallet（plan §7）。 */
import type { Db } from '@ai-gateway/db';
import type { DomainOperations } from '../platform/operations.js';

/** 域操作 kinds 白名单（ledger-core fail-closed） */
export const CHANNEL_BUDGET_OPERATION_KINDS = ['channel.recharge', 'channel.adjust'] as const;

export interface ChannelBudgetDeps {
  db: Db;
  clock?: () => Date;
}

export interface ChannelBudgetContext {
  db: Db;
  operations: DomainOperations;
  clock: () => Date;
}

/** 渠道敞口预留命令（路由选渠前；同一请求 fallback 换渠道原子替换） */
export interface ReserveChannelCommand {
  requestId: string;
  /** 目标渠道（同一请求 fallback 换渠道时，旧渠道敞口在本次事务内原子释放） */
  channelId: number;
  /** 本次上游成本预估（元，官方价×上界，系数=1） */
  amount: string;
}

export interface ChannelReservationResult {
  allowed: boolean;
  /** 拒绝时的剩余可用额度（元，string）；放行时为本渠道本次预留后剩余 */
  remaining: string;
  /** 是否为本请求切换了渠道（释放了旧渠道敞口） */
  switched: boolean;
}

export interface ChannelBudget {
  recharge(input: {
    operationId: string;
    channelId: number;
    amount: string;
    orderNo?: string | null;
    voucherKey?: string | null;
    remark?: string | null;
    adminId: number;
  }): Promise<{ rechargeId: number; balanceAfter: string; replayed: boolean }>;
  adjust(input: {
    operationId: string;
    channelId: number;
    amount: string;
    remark?: string | null;
    adminId: number;
  }): Promise<{ rechargeId: number; balanceAfter: string; replayed: boolean }>;
}
