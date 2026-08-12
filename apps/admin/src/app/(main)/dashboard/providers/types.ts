// client-safe 类型
export interface ProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  status: number;
  createdAt: string;
  updatedAt: string | null;
}
