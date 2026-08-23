/**
 * 订阅呈现：subscription-read 适配器基础行 + Decimal 派生（剩余额度/续费总价/
 * 剩余价值——v1 SQL 口径的等价计算）→ /v1/subscriptions wire 行。
 */
import { Decimal } from '@tokenlens/billing';

/** subscription-read 产出基础行（派生字段由本 presenter 计算） */
export interface SubscriptionBaseRow {
  id: number;
  planId: number;
  planName: string | null;
  planSortOrder: number | null;
  allowSeats: boolean;
  periodDays: number;
  status: number;
  orgId: number | null;
  quantity: number;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  price: string;
  planPrice: string;
  startAt: Date;
  endAt: Date;
}

/** api-client CurrentSubscription 口径 */
export interface MySubscriptionRow extends SubscriptionBaseRow {
  remainingAmount: string;
  renewPrice: string;
  remainingValue: string;
}

export function toMySubscriptionRow(r: SubscriptionBaseRow): MySubscriptionRow {
  const remaining = Decimal.max(
    new Decimal(r.quotaAmount).minus(r.usedAmount).minus(r.reservedAmount),
    new Decimal(0),
  );
  const quota = new Decimal(r.quotaAmount);
  const price = new Decimal(r.price);
  return {
    ...r,
    remainingAmount: remaining.toString(),
    // 续费总价 = 当前档单价 × 席位（v1 SQL 口径）
    renewPrice: new Decimal(r.planPrice).times(r.quantity).toString(),
    // 剩余价值 = 总价 × 剩余额度/额度
    remainingValue: quota.isZero() ? '0' : price.times(remaining.div(quota)).toString(),
  };
}

/** 公开套餐目录行（GET /v1/plans；kind 固定 subscription——pack 不进用户面目录） */
export interface PlanRow {
  id: number;
  name: string;
  kind: string;
  sortOrder: number | null;
  price: string;
  periodDays: number;
  quotaAmount: string;
  allowSeats: boolean;
  status: number;
}
