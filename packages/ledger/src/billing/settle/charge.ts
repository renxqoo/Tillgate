import { and, eq, sql } from 'drizzle-orm';
import { Decimal, toDecimal, toStorage } from '@ai-gateway/money';
import { userSubscriptions, users } from '@ai-gateway/db/schema';
import { BillingInvariantError } from '../errors.js';
import type { DbTx, ReservationProjectionRow } from '../types.js';

/**
 * 扣费执行（拆自 settleClaim，行为零变更）：按授权落列的计费域严格分路。
 *
 *   包月 Key（subscription_id 非空）：释放套餐在途敞口 → plan 部分封顶在
 *     「释放后剩余额度」内（套餐额度永不为负，无余额兜底）→ ε 溢出即红灯。
 *   普通 Key：单条原子 UPDATE 同时「释放余额在途敞口 + 按实际金额扣款」；
 *     信用地板由 users_balance_credit_floor_ck 兜底（23514 → invariant → dead 复核）。
 */
export interface ChargeOutcome {
  planCharge: Decimal;
  paygCharge: Decimal;
  /** 余额流水快照（普通 Key 非 0 元时有值；供 consume 流水） */
  balanceBefore: string | null;
  balanceAfter: string | null;
}

export async function applyCharge(
  tx: DbTx,
  billing: ReservationProjectionRow,
  calculated: Decimal,
  calculatedAmount: string,
): Promise<ChargeOutcome> {
  let planCharge = new Decimal(0);
  let paygCharge = new Decimal(0);
  let balanceBefore: string | null = null;
  let balanceAfter: string | null = null;

  if (billing.subscriptionId != null) {
    // 包月 Key：plan 部分封顶在「释放后剩余额度」内，套餐额度永不为负；无余额兜底。
    const planReserve = toDecimal(billing.planReservedAmount ?? '0');
    // 释放套餐在途敞口（本请求的 plan 部分），并读回当前 used 以计算剩余。
    const subReleased = await tx
      .update(userSubscriptions)
      .set({
        reservedAmount: sql`${userSubscriptions.reservedAmount} - ${planReserve.toString()}::numeric`,
      })
      .where(
        sql`${userSubscriptions.id} = ${billing.subscriptionId}
            and ${userSubscriptions.reservedAmount} >= ${planReserve.toString()}::numeric`,
      )
      .returning({
        quotaAmount: userSubscriptions.quotaAmount,
        usedAmount: userSubscriptions.usedAmount,
      });
    if (subReleased.length === 0) throw new BillingInvariantError('subscription_reservation_invariant');
    const remaining = toDecimal(subReleased[0]!.quotaAmount).minus(
      toDecimal(subReleased[0]!.usedAmount),
    );
    planCharge = Decimal.min(calculated, remaining.gt(0) ? remaining : new Decimal(0));
    paygCharge = calculated.minus(planCharge);
    if (paygCharge.gt(0)) {
      // 授权时已预留足额额度，ε 溢出理论上不应发生；真发生即无余额可兜底 → 亮红灯人工复核。
      throw new BillingInvariantError('subscription_quota_exhausted_during_settle');
    }
  } else {
    // 普通 Key：只扣余额。单条原子 UPDATE 同时「释放余额在途敞口 + 扣款」；
    // 信用地板由 users_balance_credit_floor_ck 兜底（23514 → classify invariant → dead 复核）。
    const reserved = toDecimal(billing.reservedAmount);
    planCharge = new Decimal(0);
    paygCharge = calculated;
    const charged = await tx
      .update(users)
      .set({
        reservedBalance: sql`${users.reservedBalance} - ${reserved.toString()}::numeric`,
        balance: sql`${users.balance} - ${calculatedAmount}::numeric`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(users.id, billing.userId),
          sql`${users.reservedBalance} >= ${reserved.toString()}::numeric`,
        ),
      )
      .returning({ balance: users.balance });
    if (charged.length === 0) throw new BillingInvariantError('billing_reservation_invariant');
    // 0 元（免费模型）：不扣款、不写余额流水（只写 usage_logs）。
    if (!calculated.isZero()) {
      balanceAfter = charged[0]!.balance;
      balanceBefore = toStorage(toDecimal(balanceAfter).plus(calculated));
    }
  }

  return { planCharge, paygCharge, balanceBefore, balanceAfter };
}
