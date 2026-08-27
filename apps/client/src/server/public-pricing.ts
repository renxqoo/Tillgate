/**
 * 公开定价读取（未登录可达：营销首页免费模型广场 + /pricing 公开定价表）。
 * 定价契约是宽松解析（q/free/page/pageSize，非法值回落默认），
 * 与用户面列表的 page/limit strict 契约不同源，出参信封键为 models。
 */
import type { PricingPage } from '@tillgate/api-client';

import { createClientApi } from './api';

export interface PublicPricingQuery {
  q?: string;
  free?: boolean;
  page?: number;
  pageSize?: number;
}

function buildPricingQuery(query: PublicPricingQuery): string {
  const sp = new URLSearchParams();
  if (query.q && query.q !== '') sp.set('q', query.q);
  if (query.free != null) sp.set('free', query.free ? 'true' : 'false');
  if (query.page != null && Number.isFinite(query.page)) sp.set('page', String(query.page));
  if (query.pageSize != null && Number.isFinite(query.pageSize)) {
    sp.set('pageSize', String(query.pageSize));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** 公开定价页；后端不可达返回 null（页面按「目录暂不可用」渲染，不炸页） */
export async function fetchPublicPricing(
  query: PublicPricingQuery = {},
  fetchImpl?: typeof globalThis.fetch,
): Promise<PricingPage | null> {
  try {
    return await createClientApi(fetchImpl ? { fetch: fetchImpl } : {}).get<PricingPage>(
      `/v1/pricing${buildPricingQuery(query)}`,
      { revalidate: false },
    );
  } catch {
    return null;
  }
}
