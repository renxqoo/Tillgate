/**
 * 冻结单域规则（纯函数）：两阶段状态与结算约束。
 * 状态机：active → settled（实扣落定）/ released（取消）/ expired（超时）——单向，无回流。
 */
import { Decimal } from './money.js';
import {
  AuthorizationNotActiveError,
  SettleExceedsHoldError,
} from './errors.js';

export type AuthorizationStatus = 'active' | 'settled' | 'released' | 'expired';

/** 仓储行形状（status 为库中字符串；语义判定见下方断言函数） */
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
 *   非 active → NotActive（上层据此走重放/拒绝分岔）
 *   已过期（expiresAt ≤ 数据库时钟）→ NotActive('expired')
 *   实扣 > 冻结额 → SettleExceedsHold（settle ≤ hold 是内核保证）
 */
export function assertSettleable(
  auth: AuthorizationSnapshot,
  settleAmount: Decimal,
  databaseNow: Date,
): void {
  if (auth.status !== 'active') {
    throw new AuthorizationNotActiveError(auth.refType, auth.refId, auth.status);
  }
  if (auth.expiresAt && auth.expiresAt.getTime() <= databaseNow.getTime()) {
    throw new AuthorizationNotActiveError(auth.refType, auth.refId, 'expired');
  }
  if (settleAmount.gt(new Decimal(auth.amount))) {
    throw new SettleExceedsHoldError(auth.amount, settleAmount.toString());
  }
}

/** 释放前置：仅 active 可释放（released/expired/settled 均为终态或已了结） */
export function assertReleasable(auth: AuthorizationSnapshot): void {
  if (auth.status !== 'active') {
    throw new AuthorizationNotActiveError(auth.refType, auth.refId, auth.status);
  }
}
