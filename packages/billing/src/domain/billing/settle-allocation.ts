/**
 * 结算分配规则（纯函数）——多来源预扣如何分摊一笔实际扣款：
 *
 *   消耗按消费优先级排序进行（订阅先耗、PAYG 后耗；= 明细 id 序 = 提交序），
 *   每源 consume = min(预留额, 剩余待扣)；未用完的预留余量由各源结算原语隐式归还
 *   （wallet.settle ≤ hold 自动还差、trySettleQuota 全额核销）。
 *   超额（actual > Σ预留）：兜底源 PAYG 以 over 表达（走补充授权）；
 *   纯订阅链超额也以 over 表达，由订阅来源把预留内份额核销到套餐、超额补扣余额。
 */
import { DefectError } from '@tillgate/errors';
import { Decimal } from '../money.js';

export interface ReservationShare {
  sourceType: string;
  amount: string;
}

export interface SettleShare {
  sourceType: string;
  /** 本源结算消耗（≤ 该源预留额；预留余量随结算原语归还） */
  consume: string;
  /** 超额部分：由兜底来源走补充授权（authorize#over + settle#over），可形成负余额 */
  over: string;
}

/** 兜底源类型（超额吸收者） */
const FALLBACK_TYPE = 'payg';

export function allocateSettlement(
  shares: readonly ReservationShare[],
  actual: Decimal,
): SettleShare[] {
  if (shares.length === 0) {
    if (actual.gt(0)) {
      throw new DefectError('settle_allocation_no_source', 'billing.billing_invariant');
    }
    return [];
  }

  let remaining = actual;
  const out: SettleShare[] = shares.map((share) => {
    const take = Decimal.min(new Decimal(share.amount), Decimal.max(remaining, new Decimal(0)));
    remaining = remaining.minus(take);
    return { sourceType: share.sourceType, consume: take.toString(), over: '0' };
  });

  if (remaining.gt(0)) {
    const fallback = out.find((share) => share.sourceType === FALLBACK_TYPE);
    if (fallback != null) {
      fallback.over = remaining.toString();
    } else {
      // 纯订阅链：预留内核销套餐，超额转余额补扣（可形成负余额）。
      const last = out.at(-1);
      if (last === undefined) {
        throw new Error('settle_allocation: pure subscription chain must be non-empty');
      }
      last.over = remaining.toString();
    }
  }
  return out;
}
