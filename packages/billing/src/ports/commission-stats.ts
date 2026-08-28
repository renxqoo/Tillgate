/**
 * 佣金聚合统计 port（跨域只读——usage_logs（本包）× referrals/users（accounts
 * 域表，经 @tillgate/db schema 只读 join）：被邀请人已结算消费按邀请人求和。生产实现 postgres；测试内存。
 */
export interface InviteeSpendByInviter {
  inviterId: number;
  /** 窗口内被邀请人已结算消费合计（元，numeric 全精度字符串） */
  total: string;
}

export interface CommissionStatsStore {
  /**
   * [from, to) 窗口聚合。过滤口径：
   * usage_logs.status=0（成功已计费）× referrals.status=0（正常邀请关系）×
   * 邀请人账号正常（users.status=0——封禁停发，重跑自动补齐窗口内份额）。
   */
  sumInviteeSpendByInviter(input: { from: Date; to: Date }): Promise<InviteeSpendByInviter[]>;
}
