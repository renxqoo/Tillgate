// client-safe 类型
export interface RateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  coefficient: string;
}
