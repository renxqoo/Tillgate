// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface PlanRow {
  id: number;
  name: string;
  /** 售价（元，numeric 字符串） */
  price: string;
  /** 周期天数（30=月付，365=年付） */
  periodDays: number;
  /** 套餐额度（元，numeric 字符串） */
  quotaAmount: string;
  /** 额度耗尽后是否走余额兜底 */
  fallbackToBalance: boolean;
  /** 0=上架，1=下架 */
  status: number;
}
