// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface PlanRow {
  id: number;
  name: string;
  /** subscription=包月订阅，pack=加油包 */
  kind: 'subscription' | 'pack';
  /** 展示层级（subscription 用于升级排序，pack 无层级可为 null） */
  sortOrder: number | null;
  /** 售价（元，numeric 字符串） */
  price: string;
  /** 周期天数（30=月付，365=年付；pack 恒为 0） */
  periodDays: number;
  /** 套餐额度（元，numeric 字符串） */
  quotaAmount: string;
  /** 额度耗尽后是否走余额兜底 */
  fallbackToBalance: boolean;
  /** 是否支持席位（团队套餐）；false=个人套餐固定 1 席 */
  allowSeats: boolean;
  /** 0=上架，1=下架 */
  status: number;
}
