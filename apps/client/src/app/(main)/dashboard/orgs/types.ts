// client-safe 类型（不依赖 "use server" 文件）。
export interface OrgRow {
  id: number;
  name: string;
  role: 'owner' | 'member';
  subscriptionId: number | null;
  subscriptionName: string | null;
}

export interface OrgMemberRow {
  userId: number;
  role: string;
  status: number;
  dailySpendLimit: string | null;
  monthlyQuota: string | null;
  email: string | null;
  displayName: string | null;
}
