/** 公开定价页取数（未登录；官方价口径 = model_mappings 官方三元组/单位价） */

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

export const PRICING_UNIT_LABEL: Record<string, string> = {
  token: '按 Token',
  request: '按次',
  image: '按张',
  second: '按秒',
  char: '按字符',
};

export async function fetchPublicPricing(): Promise<PricingModel[] | null> {
  const base = process.env.CLIENT_API_BASE ?? 'http://127.0.0.1:8791';
  const res = await fetch(`${base}/api/public/pricing`, { cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { models?: PricingModel[] };
  return data.models ?? null;
}
