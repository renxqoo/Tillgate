// client-safe 类型（不依赖 @ai-gateway/api-client）
export interface ChannelFundRow {
  id: number;
  channelId: number;
  channelName: string;
  type: 'recharge' | 'adjust';
  /** 有符号金额（元，numeric 字符串） */
  amount: string;
  /** 变动后渠道额度余额快照（元） */
  balanceAfter: string;
  orderNo: string | null;
  voucher: string | null;
  remark: string | null;
  adminId: number | null;
  adminEmail: string | null;
  adminDisplayName: string | null;
  createdAt: string;
}

export interface ChannelOption {
  id: number;
  name: string;
}
