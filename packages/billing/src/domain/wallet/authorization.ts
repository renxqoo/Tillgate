/**
 * 冻结单域规则（纯函数）：两阶段状态与结算约束。
 * 状态机：active → settled（实扣落定）/ released（取消）/ expired（超时）——单向，无回流。
 */
import { Decimal } from '../money.js';
import { BillingErrors } from '../errors.js';

export type AuthorizationStatus = 'active' | 'settled' | 'released' | 'expired';

/** 冻结单快照（adapters 装载的仓储行形状） */
export interface AuthorizationSnapshot {
  id: string;
  accountId: string;
  refType: string;
  refId: string;
  amount: string;
  status: string;
  settledAmount: string | null;
  expiresAt: Date | null;
}

/**
 * 结算前置校验（锁定行之后、CAS 之前）：
 *   非 active → not_active（上层据此走重放/拒绝分岔）
 *   已过期（expiresAt ≤ 数据库时钟）→ not_active('expired')
 *   实扣 > 冻结额 → settle_exceeds_hold（settle ≤ hold 是内核保证）
 */
export function assertSettleable(
  auth: AuthorizationSnapshot,
  settleAmount: Decimal,
  databaseNow: Date,
): void {
  if (auth.status !== 'active') {
    throw BillingErrors.business('authorization_not_active', {
      refType: auth.refType,
      refId: auth.refId,
      status: auth.status,
    });
  }
  if (auth.expiresAt && auth.expiresAt.getTime() <= databaseNow.getTime()) {
    throw BillingErrors.business('authorization_not_active', {
      refType: auth.refType,
      refId: auth.refId,
      status: 'expired',
    });
  }
  if (settleAmount.gt(new Decimal(auth.amount))) {
    throw BillingErrors.business('settle_exceeds_hold', {
      held: auth.amount,
      requested: settleAmount.toString(),
    });
  }
}

/** 释放前置：仅 active 可释放（released/expired/settled 均为终态或已了结） */
export function assertReleasable(auth: AuthorizationSnapshot): void {
  if (auth.status !== 'active') {
    throw BillingErrors.business('authorization_not_active', {
      refType: auth.refType,
      refId: auth.refId,
      status: auth.status,
    });
  }
}
