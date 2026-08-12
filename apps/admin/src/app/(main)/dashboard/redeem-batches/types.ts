// client-safe 类型
export interface RedeemBatchRow {
  id: number;
  name: string;
  remark: string | null;
  amount: string;
  total: number;
  usedCount: number;
  createdBy: string;
  createdAt: string;
}

export interface RedeemCodeRow {
  id: number;
  codeMasked: string;
  status: number;
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
}
