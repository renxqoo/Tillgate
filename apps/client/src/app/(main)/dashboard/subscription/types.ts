// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface CurrentSubscription {
  id: number;
  planId: number;
  planName: string;
  /** 套餐层级（用于升级目标筛选，null 表示无层级） */
  planSortOrder: number | null;
  /** 是否支持席位（团队套餐）；false=个人套餐固定 1 席 */
  allowSeats: boolean;
  /** 席位数量 */
  quantity: number;
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
  /** 当前售价快照（元，numeric 字符串） */
  price: string;
  fallbackToBalance: boolean;
  /** 周期天数（30=月付，365=年付） */
  periodDays: number;
  /** 续费总价（元）= 当前档价 × 席位 */
  renewPrice: string;
  /** 当前档单价（元/席） */
  planPrice: string;
  /** 剩余价值（元）= 总价 × (额度-已用-在途)/额度 */
  remainingValue: string;
}

/** 订阅页 Key 区块用的精简 Key 行。 */
export interface SubKeyRow {
  id: number;
  keyPreview: string;
  name: string;
  status: number;
  dailySpendLimit: string | null;
}

export interface PlanRow {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
  /** 售价（元，numeric 字符串） */
  price: string;
  /** 周期天数（30=月付，365=年付） */
  periodDays: number;
  /** 套餐额度（元） */
  quotaAmount: string;
  fallbackToBalance: boolean;
  /** 是否支持席位（团队套餐）；false=个人套餐固定 1 席 */
  allowSeats: boolean;
  status: number;
}
