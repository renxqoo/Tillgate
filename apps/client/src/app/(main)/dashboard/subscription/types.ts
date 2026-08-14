// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface CurrentSubscription {
  id: number;
  planId: number;
  planName: string;
  startAt: string;
  endAt: string;
  /** 套餐额度（元，numeric 字符串） */
  quotaAmount: string;
  /** 已用额度（元） */
  usedAmount: string;
  /** 在途预留（元） */
  reservedAmount: string;
  /** 剩余额度（元） */
  remainingAmount: string;
  fallbackToBalance: boolean;
}

export interface PlanRow {
  id: number;
  name: string;
  /** 售价（元，numeric 字符串） */
  price: string;
  /** 周期天数（30=月付，365=年付） */
  periodDays: number;
  /** 套餐额度（元） */
  quotaAmount: string;
  fallbackToBalance: boolean;
  status: number;
}
