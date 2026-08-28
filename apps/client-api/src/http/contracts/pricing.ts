/**
 * 公开定价契约：宽松查询解析（q/free/page/pageSize——公共端点非法值回落默认而非 400）。
 * 单页上界 500（目录可达数千，列表永不无界返回）。
 */
export const PRICING_MAX_PAGE_SIZE = 500;
export const PRICING_DEFAULT_PAGE_SIZE = 100;

export interface PricingQuery {
  q: string;
  free: boolean | null;
  page: number;
  pageSize: number;
}

export function parsePricingQuery(url: URL): PricingQuery {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const freeRaw = url.searchParams.get('free');
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSizeRaw = Number.parseInt(url.searchParams.get('pageSize') ?? '', 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(1, pageSizeRaw), PRICING_MAX_PAGE_SIZE)
    : PRICING_DEFAULT_PAGE_SIZE;
  return {
    q,
    free: freeRaw == null ? null : freeRaw === 'true' || freeRaw === '1',
    page,
    pageSize,
  };
}
