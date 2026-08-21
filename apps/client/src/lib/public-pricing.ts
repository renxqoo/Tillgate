/** 公开定价页取数（未登录；官方价口径 = model_mappings 官方三元组/单位价）
 *  分页/搜索参数透传 client-api /v1/pricing——目录可达数千（模型市场导入），
 *  列表永不无界拉全量。 */

export interface PricingModel {
  id: number;
  externalName: string;
  contextLength: number | null;
  pricingUnit: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  unitPrice: string;
  isFree: boolean;
  effective: { inputPrice: string; outputPrice: string; cacheInputPrice: string; unitPrice: string };
  coefficient: string;
}

export interface PricingQuery {
  q?: string;
  free?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PricingPage {
  models: PricingModel[];
  total: number;
  page: number;
  pageSize: number;
}

export const PRICING_UNIT_LABEL: Record<string, string> = {
  token: '按 Token',
  request: '按次',
  image: '按张',
  second: '按秒',
  char: '按字符',
};

export async function fetchPublicPricing(query: PricingQuery = {}): Promise<PricingPage | null> {
  const base = process.env.CLIENT_API_BASE || 'http://localhost:8081';
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.free != null) params.set('free', String(query.free));
  if (query.page != null) params.set('page', String(query.page));
  if (query.pageSize != null) params.set('pageSize', String(query.pageSize));
  const qs = params.size > 0 ? `?${params}` : '';
  const res = await fetch(`${base}/v1/pricing${qs}`, { cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json()) as PricingPage;
}
