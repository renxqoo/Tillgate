// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface SubscriptionRow {
  id: number;
  userId: number;
  userSubject: string;
  userDisplayName: string | null;
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
  /** 0=有效，1=到期，2=取消 */
  status: number;
  createdAt: string;
}
